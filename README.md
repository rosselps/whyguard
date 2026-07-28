# WhyGuard

**Git remembers what changed. WhyGuard reconstructs *why* — and stops humans and AI agents from deleting that reason by accident.**

[Español](./README.es.md) · [Feeding WhyGuard](./docs/guides/feeding-whyguard.md) · [Architecture](./docs/architecture/architecture.md)

```bash
npx whyguard demo        # see it work, no account, no server, no config
npx whyguard init        # protect a repository of your own
```

**Running deployment.** [Dashboard](https://main.d13s30epqvi33j.amplifyapp.com) ·
[the pull request it is reading](https://github.com/rosselps/whyguard-demo/pull/3). The
GitHub App analysed that pull request and published the Check Run; the dashboard is the
read-only record of it, not the product. The command above is the product.

---

## The problem

```ts
export function createOrder(idempotencyKey: string, amount: number): Order {
  const existing = existingOrders.get(idempotencyKey);
  if (existing) {
    return existing;          // <- looks redundant. Nobody remembers why.
  }
  validateAmount(amount);
```

Someone removes it. The commit message is honest and completely wrong:

> `Simplify createOrder by removing redundant duplicate check`

That guard was added eight months earlier by PR #493 to fix Issue #481: clients retry
checkout when the gateway times out, the server already charged the card, and without the
guard the customer is charged twice.

Tests pass. Linter is happy. Coverage doesn't move. The reviewer approves in 40 seconds,
because the diff genuinely looks like a simplification.

AI agents make this sharply worse. They are very good at making code look cleaner, and
they have no memory of the incident that put the ugly part there.

## What it does

```
$ npx whyguard demo
```

```text
Step 2/3  Scanning that change the way a reviewer never has time to...

[CRITICAL] src/payments/create-order.ts :: createOrder
  kind: condition_removed
  risk: 96  confidence: 100
  reason: known
  This change affects a behavior covered by the confirmed decision
  "payment-idempotency": Prevent duplicate orders when the server completes the
  operation but the client receives a timeout and retries the checkout request.
  protected property: One idempotency key creates at most one order.
  protected property: Retrying a completed request returns the existing order.
  evidence: [strong] payment-idempotency: confirmed issue #481
  evidence: [strong] payment-idempotency: confirmed pull_request #493
  evidence: [medium] Commit 11236a65e296: Enforce idempotency key on createOrder (fixes #481)
  evidence: [medium] Referenced in commit 11236a65e296: #481
  evidence: [weak]   Referenced in commit 11236a65e296: #493
```

Then, in that repository:

```
$ git commit -m "Simplify createOrder"
```

```text
WHYGUARD BLOCKED THIS COMMIT

Protected historical behavior was removed in staged changes:
src/payments/create-order.ts
  symbol: createOrder (condition_removed)
  protected property: One idempotency key creates at most one order.
  ...
Preserve the property, or add a regression test proving an equivalent
mechanism, then commit again.
```

The commit does not happen. Every evidence item above is traceable to something committed
in that repository — the contract file, the commit message, the issue references in it.
Nothing is canned.

## What it does *not* do

Run the second scenario. Same tool, same kind of change, different answer:

```bash
npx whyguard demo --scenario timeouts
```

A repository where someone shortened a timeout and dropped a retry count, and where
**nobody ever wrote down why those values were chosen**. The same two commits, scanned
before and after a human records the decision:

| | Severity | Risk | Confidence | Verdict |
|---|---|---|---|---|
| Git history alone | HIGH | 70 | 65 | warn |
| Plus the recorded decision | CRITICAL | 94.5 | 100 | **block** |

A commit message that mentions an issue is a hint. WhyGuard will report it, score it, and
explain it — and it will not refuse your commit over a hint. Only a decision a human wrote
down produces `strong` evidence, and only `strong` evidence can block.

That is the input the tool needs from you, and it is one YAML file:
[Feeding WhyGuard](./docs/guides/feeding-whyguard.md).

## How it decides

Deterministic Git and AST logic. No model is in the decision path.

```text
what changed?      ts-morph AST comparison, not a text diff
                   "a guard clause was removed from createOrder", not "5 lines changed"

why does it exist? git log -S finds the commit that INTRODUCED the removed logic,
                   then its message, PRs and issues
                   .whyguard/decisions/*.yml if a human confirmed it

how sure are we?   evidence strength: strongest item + 5 per corroborating item

what happens?      risk >= 80 AND confidence >= 75 AND strong evidence AND a
                   protected property AND no equivalent regression test  ->  BLOCK
```

```text
risk = 0.25 * moduleCriticality        + 0.20 * historicalSeverity
     + 0.20 * evidenceStrength         + 0.15 * missingRegressionTest
     + 0.10 * semanticChangeMagnitude  + 0.10 * repeatedIncidentSignal
```

Two decisions reached by being wrong first:

**Confidence uses the strongest evidence, not the average.** Averaging punished
corroboration: a confirmed contract (95) plus a weak commit reference (25) averaged to 60,
below the block threshold — so *finding more evidence made WhyGuard block less*.

**Cosmetic changes produce no finding, on purpose.** Identifier renames, redundant
parentheses, reformatted arguments, and *raising* a retry count are all ignored. A
guardrail that cries wolf on a rename gets uninstalled in a week, and then it protects
nothing.

## The layers are not equally strong

WhyGuard guards the same behavior at four moments. They offer genuinely different
guarantees, and treating them as equivalent is the easiest way to get a false sense of
safety:

| Layer | Command | Who enforces the block | Can an agent ignore it? |
|---|---|---|---|
| Kiro `PreToolUse` hook | `whyguard hook --on-block ask` | The Kiro IDE, by prompting the human | Not the prompt — see below |
| Kiro `Stop` hook | `whyguard verify --scope working-tree` | Nobody; it reports what already happened | It's a report, not a gate |
| Git `pre-commit` | `whyguard verify --scope staged` | **Git aborts the commit itself** | **No** |
| GitHub PR Check | the GitHub App | GitHub, server-side | **No** |

A `PreToolUse` hook that writes feedback to STDERR and exits `2` is only *advisory*.
Tested in the Kiro IDE with two models (MiniMax M2.5 and DeepSeek v3.2): the hook fired,
returned `2` with the full block feedback, and **both models applied the
protected-behavior-removing edit anyway** — one explained afterwards that it had removed
the idempotency protection.

So `whyguard hook` defaults to `--on-block ask`, which returns a Kiro `permissionDecision`
and makes the *IDE* prompt the human. An agent can ignore an exit code. It cannot click
through your confirmation dialog for you.

The human override is deliberate and visible: `WHYGUARD_SKIP=1 git commit`. The goal was
never to make removal impossible — only to make it impossible **by accident**.

## This is not a Kiro-only tool

Two of the four layers have no editor in them, and a third speaks a standard protocol:

| Surface | Depends on | Works in |
|---|---|---|
| Git `pre-commit` | Git | Every editor, and no editor at all |
| GitHub Check Run | a signed webhook | Server-side; the editor is irrelevant |
| MCP server | `@modelcontextprotocol/sdk` over stdio | Any MCP client, unchanged |
| Pre-write interception | the host's own hook API | One thin adapter per host |

Only the pre-write interception is host-specific, and that is not a design choice: there is
no cross-editor API for "a tool is about to write this file". So the core takes a neutral
request instead. `whyguard guard --stdin` reads a `GuardRequest` — repo root, file path,
proposed content — and an adapter's whole job is to map a host's event onto those fields.
`whyguard hook` is that adapter for Kiro, and today the only one that ships.

Kiro, Claude Code and Cursor all follow the same pattern — JSON on stdin, a decision on
stdout or via the exit code — so each additional adapter is a field rename rather than a
redesign. The per-host mapping, and what to do in a host that exposes nothing before a
write, is in [Agent hosts](./docs/guides/agent-hosts.md).

Not built yet, stated plainly: adapters for Claude Code and Cursor, and
`whyguard init --host <name>`. Also worth saying that a VS Code extension is a worse fit
than it sounds — the write worth intercepting comes from whichever agent extension the user
installed, which a second extension cannot see. The leverage is in the agent host, not in
the editor.

## Why not what already exists

| Tool | What it knows | What it misses |
|---|---|---|
| Linters, type checkers | Rules about code shape | Nothing about your incident history |
| Test coverage | That a line is executed | Whether a *deleted* line mattered |
| `CODEOWNERS`, review | Who to ask | Whether the reviewer still remembers 2024 |
| ADRs, docs | Decisions, in a folder nobody opens | The link between the decision and the line |
| `git blame` | Who touched a line last | Why the logic was introduced, after refactors moved it |

The reason is already in your repository, scattered across commit messages, PR
descriptions and issue references. It just isn't reachable at the moment someone is about
to delete it.

## Commands

| Command | What it does |
|---|---|
| `whyguard demo [--scenario payments\|timeouts]` | Self-contained walkthrough. `--list` for all scenarios |
| `whyguard init` | Wire every guardrail into a repository, in one command |
| `whyguard trace <file>:<symbol>` | What is known about a symbol, **before** you edit it |
| `whyguard scan --base <ref> --head <ref>` | Analyze a Git range |
| `whyguard verify --scope staged\|working-tree` | Check uncommitted work; exits `2` on a block |
| `whyguard install-hooks` | Install only the Git `pre-commit` hook |
| `whyguard guard --stdin` / `whyguard hook` | Evaluate one proposed edit (what the Kiro hook calls) |

`whyguard init` is idempotent, merges into existing config files, and never silently
replaces a file it doesn't recognize. It wires the Git `pre-commit` hook, the Kiro
`PreToolUse`/`Stop` hooks, the MCP server config, and an inactive contract template.

## Surfaces

- **CLI** — the table above. Zero configuration, no network, works offline.
- **Kiro** — a `PreToolUse` hook that prompts before a protected edit, a `Stop` hook that
  reports what a turn removed, and an **MCP server** exposing `whyguard.scan_diff`,
  `trace_symbol`, `get_finding`, `list_protected_properties`, `propose_regression_test`,
  and `register_decision` (the only write tool, gated behind an explicit `confirm: true`).
- **GitHub App** — on `pull_request.opened`/`synchronize`/`reopened`, clones the PR, runs
  the same deterministic core, publishes a Check Run. Verified against a real PR.
- **Dashboard** — read-only investigation UI: what was analyzed, which behavior is
  protected, the evidence timeline, and a regression-test skeleton on request. Never
  triggers a scan, never writes, never generates or runs a test on its own.

## Explanations: deterministic first, model second

Every finding gets an explanation with no model involved, built from the finding's own
evidence. That is the default and the only path the CLI uses out of the box.

Amazon Bedrock is opt-in (`WHYGUARD_LLM_ENABLED=true` plus `AWS_REGION` and
`BEDROCK_MODEL_ID`) and only ever *rewords* what the deterministic core already decided.
It cannot change a score or a verdict, and its output is treated as untrusted:

1. must parse as JSON,
2. must validate against `LlmExplanationSchema`,
3. **must not cite an evidence ID absent from the finding** — the anti-hallucination check
   a schema cannot express.

Any failure at any step falls back to the deterministic template. The UI always shows a
badge naming which path produced the text, so "was this written by a model?" is never a
guess.

## Scope, honestly

- **TypeScript and JavaScript only.** The detector is `ts-morph`-based.
- **No auto-fix, no generated tests.** It proposes a skeleton for a human to fill in. A
  guardrail that writes its own tests can write the wrong one and then approve itself.
- **No IDE extension.** Kiro integration is MCP plus hooks.
- **Blocking requires a written decision.** By design, see above.
- **Not a replacement for tests, review, or ADRs.** It covers the gap all three share: the
  moment code changes and the reason isn't in the room.

Detected: removed guard clause, removed validation call, boundary/operator change, removed
or lowered retry, changed timeout. Known gaps: special-case branches, and tests weakened
rather than removed. `required_tests` existence is checked, but WhyGuard never runs or
parses your tests. `expires_when` is stored and displayed but not yet scored.

## AWS and Kiro

| Piece | Service | Notes |
|---|---|---|
| Explanations | Amazon Bedrock | Opt-in, schema-validated, deterministic fallback |
| Dashboard | AWS Amplify Hosting | Static build output |
| API + webhook receiver | Amazon EC2 | Needs a persistent working directory for Git clones |

Kiro is used inside the product, not only to build it: the `PreToolUse` hook returns a
Kiro `permissionDecision`, and the MCP server lets an agent ask "what is protected here?"
before it edits. The repository also ships `.kiro/steering/` policies and three
`.kiro/skills/`.

**Why the clones are full clones.** The pickaxe search is the product, so `--depth` is out.
`--filter=blob:none` was tried and rejected on measurement — benchmarked against
`sindresorhus/got` (1664 commits):

| Clone | On disk | Path-scoped `git log -S` |
|---|---|---|
| full | 5.9 MB | 0.07s |
| `--filter=blob:none --no-tags` | 3.5 MB | **186.58s** |

Identical results, 2.4 MB saved, ~2600x slower, because the pickaxe round-trips to the
remote for every blob it doesn't have. Disk is protected instead by a repository size
ceiling (`WHYGUARD_MAX_REPO_SIZE_MB`, checked before cloning) and a startup sweep of
workspaces abandoned by a process that died mid-scan.

## Local development

```bash
pnpm install
pnpm build
pnpm test
pnpm typecheck
pnpm lint

pnpm --filter @whyguard/api dev         # webhook receiver + dashboard API (needs .env)
pnpm --filter @whyguard/dashboard dev   # http://localhost:5173
```

API security posture: bearer-token guard with `timingSafeEqual` that **fails closed to
loopback-only** when no token is configured, per-route rate limiting, security headers, and
repository identifiers stored as `owner/repo` so server paths never leak into reports.

```text
apps/
  cli/            whyguard CLI
  mcp-server/     MCP server (6 tools; 1 write, confirmation-gated)
  api/            GitHub App webhooks + Check Runs + read-only dashboard API
  dashboard/      Vite + React investigation UI
packages/
  contracts/      Zod schemas / shared DTOs
  domain/         risk + confidence formulas, block rule, state transitions
  git-adapter/    argument-array Git wrappers (no shell interpolation)
  github-adapter/ App auth, PR reads, Check Runs, webhook signature verification
  ast-adapter/    ts-morph sensitive-change detector
  application/    scan-diff, trace-symbol, guard-change, scan-pull-request use cases
  llm-adapter/    Bedrock + schema validation + deterministic fallback
  persistence-adapter/  SQLite (node:sqlite)
  test-fixtures/  demo repository builders
```

## Documentation

- [Feeding WhyGuard](./docs/guides/feeding-whyguard.md) — every input it reads, and the conventions worth adopting
- [Agent hosts](./docs/guides/agent-hosts.md) — the integration contract, and the mapping for Kiro, Claude Code and Cursor
- [Architecture](./docs/architecture/architecture.md) — components, data flow, trust boundaries
- [Dashboard UI/UX](./docs/design/ui-ux.md) — visual system, tokens, screen rules
- [Deploying on AWS](./docs/deploy/aws.md) — API on EC2, dashboard on Amplify
- [Manual test scenarios](./docs/demo/manual-test-scenarios.md) — step-by-step verification of every surface
- [`README.es.md`](./README.es.md) — this document in Spanish
- [`AGENTS.md`](./AGENTS.md) · [`CONTRIBUTING.md`](./CONTRIBUTING.md)

## Team

Built for the Hackathon IA Masivo Online AWS (Código Facilito × AWS), July 2026.

| | |
| --- | --- |
| Rossel Perez | psrosseli@gmail.com |
| Marco Chumbes | markitos02chum@gmail.com |
| José Huarcaya | josemariahuarcaya2002@outlook.es |
| Jhory Valvidia | wifi.arzuz@gmail.com |

MIT licensed.
