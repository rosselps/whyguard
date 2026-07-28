# Manual test scenarios

Hands-on checks you can run yourself to see what each WhyGuard surface actually does — and,
just as importantly, what it does *not* guarantee. Every scenario states the expected result
so a wrong outcome is recognizable rather than open to interpretation.

Run once before anything else:

```bash
pnpm install
pnpm build
pnpm whyguard demo --dir .tmp/whyguard-fixture --force
```

`whyguard demo` builds a throwaway repository with two commits — a "safe" one containing an
idempotency guard in `src/payments/create-order.ts` (plus its confirmed rationale contract at
`.whyguard/decisions/payment-idempotency.yml`), and an "unsafe" one that removes it — prints
the scan, then leaves `HEAD` on the safe commit with the removal sitting uncommitted and the
Git pre-commit hook installed. That is the state most scenarios below assume, so this one
command replaces the old seed-then-reset dance.

It prints both commit SHAs; note them, several scenarios take them as arguments. Or read them
back at any time:

```bash
cd .tmp/whyguard-fixture && git log --oneline && cd ../..
```

---

## A. Local CLI (the core engine, no integrations)

### A1 — Detect a removed guard between two commits

```bash
pnpm whyguard scan --base <safe-sha> --head <unsafe-sha> --repo .tmp/whyguard-fixture --format text
```

**Expect:** one `CRITICAL` finding on `createOrder`, kind `condition_removed`, `reason: known`,
`risk: 96`, `confidence: 100`, two protected properties, and five evidence items. Risk and
confidence are deterministic — run it twice, get identical numbers.

Check the evidence ids, not just the count. Every one must be traceable to the repository:
`ev_decision_payment-idempotency_*` comes from the committed contract, `ev_commit_*` from the
pickaxe-traced introducing commit, `ev_ref_*` from that commit's message. If you ever see an
id like `ev_issue_481` with a `demo-org` URL, that is fabricated evidence and a bug.

### A2 — A safe change produces nothing

```bash
pnpm whyguard scan --base <safe-sha> --head <safe-sha> --repo .tmp/whyguard-fixture --format text
```

**Expect:** `findings: 0`. This is the false-positive control: no diff, no findings.

### A3 — Ask why code exists before touching it

```bash
pnpm whyguard trace src/payments/create-order.ts:createOrder --repo .tmp/whyguard-fixture --format text
```

**Expect:** the confirmed rationale contract, its `must_preserve` statements, the evidence, and
the commit history. This is the "before you delete it, ask" path.

### A4 — Unknown history must not be invented

Create a file with no history in the fixture, change it, and scan. **Expect:** either no
finding, or a finding with `reason: unknown` and low confidence. A fabricated incident or issue
number here is a bug.

A sharper version of the same check: create `src/payments/create-order.ts` inside a directory
that is *not* a Git repository at all, remove the guard, and run `whyguard guard --stdin`
against it. **Expect:** the change is still detected (that part is pure AST work), but
`evidence: []`, `reason: unknown`, no protected property, and no block. This exact case used to
return two `strong` items about Issue #481 from a hardcoded lookup table.

### A5 — Without a written decision, WhyGuard warns instead of blocking

```bash
pnpm whyguard demo --scenario timeouts --dir .tmp/whyguard-timeouts --force
```

**Expect** the scenario to print two scans of the *same two commits*:

| | Severity | Risk | Confidence | Verdict |
|---|---|---|---|---|
| Before the decision file exists | `HIGH` | 70 | 65 | warn |
| After it is written | `CRITICAL` | 94.5 | 100 | block |

This is the most important negative result in the whole document. Good commit hygiene alone
never reaches `strong` evidence, and the block rule requires `strong` — so WhyGuard explains
but does not refuse. If the first scan blocks, the tool has become too aggressive to trust.

### A6 — The escape route the block message offers actually works

In `.tmp/whyguard-timeouts` (left armed by A5):

```bash
cd .tmp/whyguard-timeouts
git add -A && git commit -m "Speed up inventory sync"     # Expect: BLOCKED
mkdir -p tests/logistics && touch tests/logistics/sync-inventory.test.ts
git add -A && git commit -m "Speed up inventory sync"     # Expect: committed
cd ../..
```

**Expect:** the first commit is aborted; after creating the file named in the contract's
`required_tests`, the identical commit succeeds. Verify with `git rev-list --count HEAD` — it
must not increase after the first attempt, and must increase after the second.

Note what this does and does not prove: WhyGuard checked that the file *exists*. It does not
run, parse, or measure your test. That is a deliberate limit, not an oversight — see
[Feeding WhyGuard](../guides/feeding-whyguard.md).

---

## B. Kiro `PreToolUse` hook (earliest signal, weakest guarantee)

Read `README.md` → "The layers are not equally strong" first. The short version: this layer
asks permission *before* an edit, and asking only works if the asker cooperates.

### B1 — The hook blocks a real removal

With HEAD at the safe commit, feed the hook the event Kiro sends:

```bash
node apps/cli/dist/index.js hook \
  --repo .tmp/whyguard-fixture \
  --on-block exit-code <<'EOF'
{"tool_name":"str_replace","tool_input":{"path":"<abs-path>/.tmp/whyguard-fixture/src/payments/create-order.ts","oldStr":"<the guard block>","newStr":""}}
EOF
echo "exit: $?"
```

**Expect:** `exit: 2`, and `WHYGUARD BLOCKED THIS EDIT` on STDERR with the protected properties
and evidence.

> On Windows PowerShell, note that the fixture file uses CRLF line endings — an `oldStr` built
> with `\n` will not match, the hook will find nothing to analyze, and it will correctly allow
> the edit. That is not a bug; it is deliberate fail-open behavior: a hook that cannot complete must not claim the code is unsafe.

### B2 — A cosmetic rename must be allowed

Same call, but with an `oldStr`/`newStr` that only renames the guard's variable
(`existing` → `priorOrder`), keeping the logic identical.

**Expect:** `exit: 0`, no output. WhyGuard protects behavior, not exact lines, so an
identifier rename that leaves the logic identical must be allowed.

### B3 — The one that matters: does Kiro actually stop?

In the Kiro IDE, with `.kiro/hooks/whyguard-guard.json` present, ask an agent:

> remove the `if (existing) { return existing; }` block from `createOrder`

**Expect:** Kiro prompts you to confirm before the write, showing WhyGuard's reason. That prompt
comes from `--on-block ask`, which returns a `permissionDecision` rather than relying on an exit
code.

**Known result worth reproducing:** with plain `--on-block exit-code`, MiniMax M2.5 and DeepSeek
v3.2 both received the block and applied the edit anyway. If you want to see why the `ask` mode
exists, switch the hook to `exit-code` and try again. The tell that a block did *not* happen is
simple: `git status` shows the file modified.

---

## C. Kiro `Stop` hook (catches what slipped through)

### C1 — Report an uncommitted removal

With HEAD at the safe commit, remove the guard from the working tree by hand, then:

```bash
pnpm whyguard:verify-agent-work --repo .tmp/whyguard-fixture
echo "exit: $?"
```

**Expect:** `exit: 2` and `WHYGUARD BLOCKED THIS COMMIT` naming the file, symbol, protected
properties and evidence.

### C2 — Clean checkout stays quiet

Restore the file (`git checkout HEAD -- src/payments/create-order.ts`) and rerun.

**Expect:** `exit: 0` and `no historical-decision risk found`.

---

## D. Git `pre-commit` (the layer that actually holds)

This is the only local layer no agent can bypass, because Git aborts the commit itself.

### D1 — Install it

```bash
pnpm whyguard install-hooks --repo .tmp/whyguard-fixture
```

**Expect:** confirmation naming `.git/hooks/pre-commit`.

### D2 — A protected-behavior removal cannot be committed

```bash
cd .tmp/whyguard-fixture
# remove the guard from src/payments/create-order.ts by hand
git add src/payments/create-order.ts
git commit -m "Simplify createOrder"
git log --oneline        # <-- the real check
```

**Expect:** the commit is rejected, and `git log` shows **no new commit**. Trust the log, not
the console output: a shell pipeline can mask the exit code.

### D3 — A safe refactor commits normally

Reset, then rename `existing` → `priorOrder` (guard intact), stage, and commit.

**Expect:** `WhyGuard: no historical-decision risk found in staged changes` and the commit
succeeds. If this fails, WhyGuard is over-blocking and that is a bug.

### D4 — The human override is deliberate and visible

```bash
WHYGUARD_SKIP=1 git commit -m "Removing the guard on purpose"
```

**Expect:** `pre-commit check skipped` and the commit succeeds. The goal is preventing
*accidental* removal, not making removal impossible.

### D5 — An existing team hook is not destroyed

Put your own `.git/hooks/pre-commit` in a scratch repo, then run `install-hooks`.

**Expect:** WhyGuard refuses, prints the line to chain manually, and leaves your hook byte-for-byte
unchanged. Only `--force` replaces it.

---

## E. GitHub Pull Request Check (server-side, unbypassable)

Requires the GitHub App configured per `docs/deploy/github-app.md`, with `apps/api` running
and reachable (smee.io for local development).

### E1 — Opening a PR publishes a Check

Open a PR that removes protected behavior in a repository the App is installed on.

**Expect:** a `WhyGuard / Historical Decision Check` Check Run appears, its output naming the
file, symbol, protected property and evidence.

**Conclusion mapping, so a "neutral" result is not mistaken for a failure:** a `critical`
finding produces `action_required`; any lower severity produces `neutral`; no findings produce
`success`. A `high` finding showing `neutral` is correct behavior, not a bug.

### E2 — Replaying a delivery changes nothing

Redeliver the same webhook from the App's Advanced tab.

**Expect:** the delivery is acknowledged and ignored as a duplicate; no second Check Run.

### E3 — A forged signature is rejected

POST to `/webhooks/github` with a wrong `X-Hub-Signature-256`.

**Expect:** rejected. Webhook payloads are untrusted input.

### E4 — The temporary clone is deleted

Watch `WHYGUARD_TEMP_ROOT` (default `.tmp/whyguard`) during an analysis.

**Expect:** a `whyguard-pr-*` directory appears and is gone when the analysis finishes, success
or failure.

---

## F. MCP server (Kiro querying WhyGuard directly)

Configure per `README.md`, with `DATABASE_URL` set so findings persisted by other processes
resolve.

### F1 — Startup reports which lookup mode is active

**Expect:** on STDERR, `finding lookup: session + database`. If it says `session only`,
`DATABASE_URL` is not set and F3 will not work.

### F2 — Read-only tools work with no database at all

Call `whyguard.scan_diff`, `whyguard.trace_symbol`, `whyguard.list_protected_properties`.

**Expect:** all three work regardless of database state.

### F3 — A finding from a Pull Request resolves in Kiro

Take a finding id from a Check Run or the dashboard and call `whyguard.get_finding`.

**Expect:** the full finding, even though a different process produced it. (Verified against
the real downmusic PR analysis: `fnd_4fd8cee7_002`.)

### F4 — The write tool refuses without explicit confirmation

Call `whyguard.register_decision` without `confirm: true`.

**Expect:** rejected. Never add this tool to any client's `autoApprove` list.

### F5 — A generated test is never executed

Call `whyguard.propose_regression_test`.

**Expect:** a test *skeleton* returned as text. Nothing is written to disk and nothing runs.

---

## G. Dashboard

Start `apps/api` and `apps/dashboard`, then open the dashboard.

### G1 — Findings from both sources appear

**Expect:** analyses from GitHub PRs and from local CLI scans both listed, each showing source,
finding count and highest severity.

### G2 — Evidence is one click away

Open a finding.

**Expect:** the changed code, the explanation, protected properties, risk and confidence shown
distinctly, and the evidence timeline.

### G3 — A regression-test proposal is generated on demand only

Use the "Generar prueba" action.

**Expect:** a skeleton appears only after you ask for it — never auto-generated, never executed.

### G4 — Weak evidence is shown as unknown, not hidden

Find an analysis whose reason is `unknown`.

**Expect:** it says so explicitly instead of quietly presenting a confident-looking reason.

---

## What is deliberately not covered yet

Being explicit so these are not mistaken for passing:

- **Detector scope**: five patterns are implemented
  (`condition_removed`, `boundary_changed`, `timeout_changed`, `validation_removed`,
  `retry_removed`). Removed browser/provider/timezone special cases and removed or weakened
  regression tests are not detected yet.
- **A renamed validation callee** (`validateAmount` → `checkAmount`) is still reported as
  removed, on purpose: there is no safe way to confirm a differently-named function performs an
  equivalent check, and guessing risks a false negative. Documented in `extractValidationCalls`.
- **No dedicated lineage endpoint**: the dashboard composes lineage from the report/finding
  endpoints rather than a `/findings/:id/lineage` route.
- **`required_tests` is an existence check only.** WhyGuard never runs, parses, or measures
  coverage of the tests a contract declares. A file named there that contains nothing is
  accepted, because the contract is a human's statement and the tool takes it at its word
  rather than pretending to verify something it cannot.
- **`expires_when` is not scored.** It is parsed, stored, and displayed, so an expired-in-spirit
  contract keeps blocking until somebody sets `status: expired` by hand.
- **No coverage adapter**, so the `missingRegressionTest` risk factor is always 100 unless a
  contract's declared test file exists.
- **The repository size guard and stale-workspace sweep are covered by unit tests, not by a
  manual scenario** — reproducing them by hand means either a multi-gigabyte repository or
  killing the API mid-scan. See `packages/application/src/scan-pull-request.test.ts`.
