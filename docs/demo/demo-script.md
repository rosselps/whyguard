# WhyGuard demo script (runbook)

This is a concrete, copy-pasteable version of the 10-step demo script from
for rehearsing
and recording the backup demo video. Every command below is real and has been run against
this repository — it is not aspirational.

Rehearsing and recording the video itself is a human task; this document exists so that part
requires no improvisation.

## Before you start

```bash
pnpm install
pnpm build
```

Have three terminals/windows ready:

1. **API terminal** — running `pnpm --filter @whyguard/api dev`.
2. **Dashboard terminal** — running `pnpm --filter @whyguard/dashboard dev`.
3. **Command terminal** — where you run `whyguard` and show output live.

`.env` must have real GitHub App credentials filled in (see `docs/deploy/github-app.md`) if
you are doing the live webhook step (step 8-9 below). If you don't have a
real installed GitHub App handy, steps 1-7 and 10 can be demoed entirely with the local CLI
and dashboard against the demo repository — skip step 8's live webhook and narrate it instead
("in a real PR, GitHub would deliver a webhook here").

## Step 1 — Show the apparently redundant idempotency condition

```bash
pnpm whyguard demo --dir .tmp/whyguard-fixture --force
```

This prints both commit SHAs, builds the throwaway repository, runs the scan, and leaves the
guard removal uncommitted with the Git hook installed. For the video, this single command is
also a usable cold open: it is the fastest path from nothing to a printed `CRITICAL` finding.

Open `.tmp/whyguard-fixture/src/payments/create-order.ts` and point at the idempotency guard
clause — narrate: "this looks like it could be deleted safely, it's just an early return."

If you have five minutes and want the strongest possible pair of moments, consider recording
`--scenario timeouts` instead of steps 5-7: it shows the same diff being warned about and then
blocked, with the only difference being that a human wrote the decision down. That is the
claim the whole tool rests on, and it lands in about 40 seconds.

## Step 2 — Ask Kiro to simplify the payment module

In a Kiro session pointed at `.tmp/whyguard-fixture` (with the MCP server and hook wired per
README's "Using the Kiro integration" section), ask Kiro to "simplify `createOrder` by
removing the redundant idempotency check."

## Step 3 — WhyGuard blocks the file-write tool call

Kiro's `PreToolUse` hook calls `whyguard hook`, which blocks. To reproduce this deterministically
without Kiro in the loop (useful for the backup video), run:

```bash
pnpm whyguard guard --repo .tmp/whyguard-fixture --stdin <<'EOF'
{
  "filePath": "src/payments/create-order.ts",
  "beforeContent": "<paste the safe file content>",
  "afterContent": "<paste the file content with the guard removed>"
}
EOF
```

Exit code `2` and the block feedback below print to stderr.

## Step 4 — Show the protected property and historical evidence

The block feedback is exactly this shape (per section 14.6):

```text
WHYGUARD BLOCKED THIS EDIT

Protected property:
One idempotency key creates at most one order.

Historical evidence:
Issue #481, PR #493, commit a8f92c.

Continue only if the new implementation preserves the property
or adds a regression test that proves an equivalent mechanism.
```

## Step 5 — Open Issue #481 and PR #493 from the finding

Run the same comparison as a full scan to get the finding's evidence with clickable context:

```bash
pnpm whyguard scan --base <safeSha> --head <unsafeSha> --format json
```

Point at `findings[0].evidence` in the output — each entry has a `type`, `title`, and (for the
demo fixture) a `strength: "strong"` rating tied to the issue/PR numbers.

## Step 6 — Generate a regression-test proposal

Against the running API + dashboard (step 8's persisted run), click "Generar prueba" on the
finding's page — this calls `GET /findings/:id/regression-test` and renders the result in a
read-only panel with a copy button only. Narrate: "WhyGuard never runs this automatically, a
human completes the assertion."

Without the dashboard running, the same proposal is available via the CLI/MCP path — the
`whyguard.propose_regression_test` MCP tool, or by calling `buildRegressionTestProposal`
directly in a script — since `apps/api`'s endpoint and the MCP tool both wrap the same pure
function.

## Step 7 — Apply a safe refactor that preserves idempotency

Edit `create-order.ts` so the guard clause's *behavior* survives (e.g. move it into a small
helper function, or keep the check but rename variables) — anything that does not match the
`condition_removed` AST pattern. Re-run the guard command from step 3 with the new
`afterContent`: it now exits `0` (allow).

## Step 8 — Open the Pull Request

Push the safe-refactor branch and open a PR against the repository your GitHub App is
installed on. If `apps/api` is running with a public URL (via smee.io for local dev, or once
deployed), GitHub delivers a `pull_request.opened` webhook automatically.

## Step 9 — WhyGuard Check becomes successful

Refresh the PR page — the "WhyGuard / Historical Decision Check" Check Run should show a
successful conclusion (zero findings from the safe refactor), replacing any earlier
`action_required` conclusion from a prior unsafe push to the same PR.

## Step 10 — Open the dashboard and show the decision lineage

```bash
# in the dashboard terminal, if not already running
pnpm --filter @whyguard/dashboard dev
```

Open `http://localhost:5173`, find the analysis run, and walk through: risk/confidence badges
-> evidence timeline (Issue #481, PR #493) -> the explanation (note the "Generado por modelo"
or "Plantilla determinística" badge, whichever applies) -> the regression-test panel from
step 6.

## Closing line

> WhyGuard does not protect old code because it is old. It protects the behavior that the
> code was introduced to preserve.
