# Deploying WhyGuard on AWS

Two pieces: the API on EC2, the dashboard on Amplify Hosting. The CLI needs neither —
`npx whyguard init` works with no server at all.

Order matters. The API has to exist before the dashboard can point at it, and the GitHub
App has to point at a URL that already answers.

| Step | Where | Who |
| --- | --- | --- |
| 1. Instance, security group, DNS | AWS + DNS console | you |
| 2. Install, build, systemd, HTTPS | on the box | `deploy/bootstrap.sh` |
| 3. App credentials | the box's `.env` | you |
| 4. Verify from outside | your laptop | `scripts/verify-deployment.mjs` |
| 5. Dashboard | Amplify console | you, with `apps/dashboard/amplify.yml` |
| 6. Webhook URL | GitHub App settings | you |

## Why EC2 and not Lambda

The API clones full repository history, because the evidence engine traces the commit that
*introduced* the behavior being changed. That rules out Lambda's 512 MB `/tmp` and
15-minute ceiling. It also rules out a shallow or blobless clone: measured on a
1664-commit repository, a blobless clone saved 2.4 MB and took the path-scoped `git log -S`
from 0.07s to 186.58s.

So the API needs a persistent working directory and a process that stays up.

## 1. What you create in AWS

- EC2 instance, Amazon Linux 2023, `t4g.small` (ARM) or `t3.small`
- 20 GB gp3 root volume — clones are transient but full-history
- Security group inbound: `443` and `80` from anywhere, `22` from your address only.
  **Not** `3000`. Behind the proxy every request reaches the API from `127.0.0.1`, which
  its guard treats as loopback and grants full read access; port 3000 exposed to the
  internet therefore bypasses the token entirely.
- An A record for `api.yourdomain.com` pointing at the instance's public IP, created
  before step 2 — Caddy cannot obtain a certificate for a name that does not resolve.

An Elastic IP is worth it: without one the address changes on stop/start and the DNS
record and the GitHub App webhook both go stale.

### With no domain of your own

GitHub refuses to deliver a webhook over plain HTTP, and a certificate needs a name. Two
ways to get one without registering anything:

**CloudFront in front of the instance.** A distribution answers on
`https://<id>.cloudfront.net` with a certificate AWS manages, so the whole path stays
inside AWS. Provision the box with `--no-tls` instead of a domain — Caddy then serves plain
HTTP on `:80` and port 3000 still never leaves the machine.

| Distribution setting | Value | Why |
| --- | --- | --- |
| Origin domain | the instance's public DNS name | |
| Protocol | HTTP only, port 80 | Caddy has no certificate in this mode |
| Allowed methods | GET, HEAD, OPTIONS, PUT, POST, PATCH, DELETE | the webhook is a POST |
| Cache policy | `CachingDisabled` | a cached `/reports` shows a stale analysis |
| Origin request policy | `AllViewerExceptHostHeader` | forwards `X-Hub-Signature-256`; anything that drops it breaks every delivery |

Turn **security protections off** on the distribution, and check the Security tab
afterwards. The console enables AWS WAF by default, and its managed rule set includes
`SizeRestrictions_BODY`, which blocks any request body over 8 KB. A `pull_request` payload is
25-30 KB, so every real delivery comes back `403 Request blocked` — from CloudFront, before
the API sees it. GitHub shows a 403 in the App's delivery log and it reads exactly like a
rejected signature. Measured on this deployment: 1 KB passed, 8 KB and up did not.

Then restrict inbound `80` to the managed prefix list
`com.amazonaws.global.cloudfront.origin-facing` so the origin is reachable only through the
distribution, and drop the `443` rule — nothing terminates TLS on the box any more.

Two consequences worth knowing. Traffic from CloudFront to the origin is unencrypted, which
is acceptable for public analyses and not for anything else. And the API's rate limit keys
on the connecting address, which is now an edge node rather than the visitor, so it bounds
total traffic instead of per-client traffic.

**A free subdomain.** A DuckDNS name (`whyguard.duckdns.org`) works with the documented
path unchanged, because `duckdns.org` is on the Public Suffix List and therefore gets its
own certificate rate limit. Two minutes of setup, one more third party in the chain.

Registering a domain in Route 53 is the third option and the one with the fewest moving
parts if a few dollars a year is acceptable: everything below then works as written.

## 2. What the script does

```bash
sudo dnf install -y git
git clone https://github.com/rosselps/whyguard.git
sudo bash whyguard/deploy/bootstrap.sh api.yourdomain.com   # or --no-tls behind CloudFront
```

It installs Node 24 and git, creates the `whyguard` service account, builds the API,
installs `deploy/whyguard-api.service` and Caddy 2.11.4 with `deploy/Caddyfile`, and
writes a `.env` template it will never overwrite. Re-running it updates the code and
restarts, so it is also the update path.

It updates with `fetch` + `reset --hard`, not `pull`, and that is deliberate: this
repository is published as a single-commit mirror, so each release replaces that commit and
a clone's branch diverges. `git pull` fails there with "divergent branches"; use
`git fetch && git reset --hard origin/main` for any clone of it.

Two details in those files are load-bearing rather than boilerplate:

- `Restart=always` — a process killed mid-scan leaves a full clone behind, and the
  startup sweep reclaims those. Restarting is also how the disk gets cleaned up.
- The Caddy `reverse_proxy` timeouts are minutes, not seconds. The API answers the
  webhook immediately but publishes the Check Run when the scan finishes.

## 3. What only you can fill in

```bash
sudo -u whyguard vi /home/whyguard/app/.env
sudo systemctl restart whyguard-api
sudo journalctl -u whyguard-api -n 30
```

From the GitHub App settings page — see [github-app.md](github-app.md) for the exact
permissions and events:

- `GITHUB_APP_ID`
- `GITHUB_PRIVATE_KEY_BASE64` — `base64 -w0 whyguard.private-key.pem`, one line
- `GITHUB_WEBHOOK_SECRET`

Then decide read access, which is the one setting that governs what an anonymous visitor
can see:

- `WHYGUARD_PUBLIC_REPOS=owner/repo,...` — those repositories readable with no
  credential. This is what a public demo dashboard needs.
- `WHYGUARD_API_TOKEN` — everything requires a bearer token. Not usable from a
  browser-only dashboard, because a Vite variable is inlined into the bundle.
- Neither — remote reads get 401.

Read the boot log before anything else. It names the mode in its last line
(`readAccess="public for ..."`), so a wrong allow-list is visible immediately instead of
being discovered by someone else.

## 4. Verify from outside

```bash
node scripts/verify-deployment.mjs --url https://api.yourdomain.com --secret <webhook secret>
```

Checks HTTPS, both health routes, that an unsigned webhook is rejected, that a correctly
signed one is accepted and a tampered one is not, which read-access mode is live, and that
port 3000 is unreachable from outside.

Behind CloudFront add `--origin <instance public dns>`: the public hostname is the edge, not
the box, so without it the port check proves nothing.

The signature checks are the reason this script exists. Raw request bytes, header casing
and body size limits are exactly what a reverse proxy quietly breaks, and "the service is
up" does not detect it. Without `--secret` those checks are skipped, not faked.

## 5. Dashboard on Amplify

1. Connect the repository, branch `main`. Do **not** enable the monorepo option and do not
   set `AMPLIFY_MONOREPO_APP_ROOT`: the build has to run at the repository root, because
   the dashboard imports workspace packages and needs the single lockfile. The monorepo
   form runs install and build inside the app root, which cannot work here.
2. Amplify picks up `amplify.yml` **from the repository root**. It only ever looks there;
   a buildspec under `apps/dashboard/` is ignored and the console quietly substitutes a
   generated build command instead, which is how you end up reviewing a truncated
   `npx turbo run build --filter=` with the framework detected as "none".
3. Confirm on the review screen: SSR deployment **off**, and the build command is the one
   from `amplify.yml`. A static Vite bundle deployed as SSR serves nothing.
4. Set `VITE_WHYGUARD_API_URL` to `https://api.yourdomain.com`. Leave
   `VITE_WHYGUARD_API_TOKEN` unset: it would ship inside the bundle.
5. Add a rewrite rule to `/index.html`, type **200 (Rewrite)**, whose source excludes asset
   extensions:

   ```
   </^[^.]+$|\.(?!(css|gif|ico|jpg|jpeg|png|txt|svg|webp|js|mjs|map|json|woff|woff2|ttf|eot)$)([^.]+$)/>
   ```

   The dashboard routes on the client, so without a rewrite the home page works and every
   direct link or refresh inside an analysis returns 404. But do **not** use the obvious
   `/<*>`: it matches the hashed bundles too, so `/assets/index-*.js` is answered with
   `index.html` at `Content-Type: text/html` and the page renders blank with no failed
   request to point at. `curl -I` on the bundle is what catches it.
6. Amplify's CDN caches responses with `s-maxage=31536000`, and editing a rewrite rule does
   not invalidate what is already cached. After changing rules, redeploy the branch
   (`aws amplify start-job --job-type RELEASE`) — that is what clears the edge.
7. Add the Amplify URL to `WHYGUARD_DASHBOARD_ORIGINS` in the API's `.env` and restart it.
   Skip this and every request from the dashboard fails CORS, which in a browser looks
   like the API is down rather than like a configuration problem.

The same thing without the console. `--custom-rules` is passed as a file because the
rewrite source contains characters the shorthand syntax mangles:

```bash
aws amplify create-app --name whyguard-dashboard --platform WEB \
  --repository https://github.com/<owner>/<repo> --oauth-token "$(gh auth token)" \
  --environment-variables VITE_WHYGUARD_API_URL=https://<api-host> \
  --custom-rules file://amplify-rules.json --enable-branch-auto-build
aws amplify create-branch --app-id <app id> --branch-name main --stage PRODUCTION
aws amplify start-job --app-id <app id> --branch-name main --job-type RELEASE
aws amplify get-job --app-id <app id> --branch-name main --job-id 1 \
  --query 'job.summary.status'
```

Then check the bundle itself, not just the home page: `VITE_` variables are inlined at
build time, so a missing one is invisible until a request fails at runtime.

```bash
curl -sI https://main.<app id>.amplifyapp.com/assets/index-<hash>.js   # expect text/javascript
curl -s  https://main.<app id>.amplifyapp.com/assets/index-<hash>.js | grep -c <api-host>
```

## 6. Point the GitHub App at it

Set the webhook URL to `https://api.yourdomain.com/webhooks/github` (full setup:
[github-app.md](github-app.md)), then open a pull request on an installed repository and
confirm a Check Run appears.

Step 4 covers signature verification against a real signed delivery. What only a real pull
request covers: cloning with an installation token from a remote host, publishing a Check
Run from a process that is not your laptop, and the repository size guard. Watch
`journalctl -u whyguard-api -f` during that first pull request.

## Cost shape

| Piece | Service | Notes |
| --- | --- | --- |
| Dashboard | Amplify Hosting | Static output, small |
| API | EC2 + EBS | The recurring cost |
| Explanations | Bedrock | Per token, and off by default |

Bedrock is the only pay-per-use piece. Leaving it off costs no functionality — only the
wording of an explanation, which falls back to a deterministic template.
