# Setting up the GitHub App

Needed only for the pull request check. The CLI, the Git hook and the Kiro integration work
with no App and no server.

Create it at **Settings → Developer settings → GitHub Apps → New GitHub App**.

## Settings

| Field | Value |
| --- | --- |
| Webhook URL | `https://api.yourdomain.com/webhooks/github` |
| Webhook secret | any long random string — keep it, it goes in `.env` |
| Homepage URL | anything, e.g. the repository |
| Where can it be installed | your account only, unless you want it public |

Uncheck **Expire user authorization tokens**? Leave it as it comes. WhyGuard never uses a
user token; it authenticates as the installation.

## Repository permissions

| Permission | Level | Used for |
| --- | --- | --- |
| Checks | **Read and write** | publishing the Check Run — the only write access |
| Contents | Read-only | cloning the repository to analyze it |
| Pull requests | Read-only | reading the PR head, base and changed files |
| Issues | Read-only | resolving issue references cited as evidence |

Nothing else. Any additional permission the App does not use is a permission it can be
abused to use.

## Subscribe to events

Only **Pull request**. The receiver acts on `opened`, `synchronize` and `reopened`, and
answers `202 ignored_event_*` to everything else.

## Credentials for the API

After creating the App:

1. **App ID** — top of the App's settings page → `GITHUB_APP_ID`
2. **Private key** — *Generate a private key*, downloads a `.pem`. Base64 it into one line
   and use that: `base64 -w0 whyguard.private-key.pem` → `GITHUB_PRIVATE_KEY_BASE64`
3. **Webhook secret** — the string you chose → `GITHUB_WEBHOOK_SECRET`

The `.pem` is the App's identity. It goes in `.env` (mode 600) or a secrets manager, never
in the repository. The API base64-encodes it only to keep a multi-line PEM in a single
environment variable; that is encoding, not protection.

## Install it

**Install App** → pick the repositories. Only installed repositories produce Check Runs.

## Confirm it works

The boot log prints what loaded, without printing the secrets:

```
[whyguard-api] INFO  Configuration loaded githubAppId="123456" webhookSecretLength=32 privateKeyLooksValid=true
```

`privateKeyLooksValid=false` means the base64 is truncated — the usual cause is pasting the
key over SSH without `-w0`.

Then check the signature path from outside, which is the part a reverse proxy breaks:

```bash
node scripts/verify-deployment.mjs --url https://api.yourdomain.com --secret <webhook secret>
```

Finally open a pull request that removes a guard clause and watch
`journalctl -u whyguard-api -f`. Deliveries are also listed under **Advanced** in the App's
settings, with the response the API gave — a `401` there means the secret does not match,
and it can be redelivered from that page rather than by pushing again.

## Local development without a public URL

```bash
npx smee-client --url https://smee.io/<channel> --target http://localhost:3000/webhooks/github
```

Set the App's webhook URL to the smee channel. Signature verification is unchanged, so this
tests the same code path — except for what only a public URL exercises: TLS, the proxy, and
cloning from a host that is not your laptop.
