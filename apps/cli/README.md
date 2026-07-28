# whyguard

Repositories remember **what** changed. WhyGuard reconstructs **why** it changed, and stops
humans or agents from erasing that protection by accident.

A line that looks redundant may be protecting a past incident: an idempotency check that
prevents duplicate payments, a tolerance that compensates for rounding, a retry that avoids a
race condition, a timeout chosen after an outage.

WhyGuard does not protect old code for being old. It protects the **behavioral property** the
code was introduced to preserve. A refactor is fine when the property still holds.

## See it in 30 seconds

No account, no server, no AWS credentials, no configuration:

```bash
npx whyguard demo
```

This builds a throwaway repository whose Git history actually contains a decision, scans a
change that removes it, and arms the Git hook — so your own next `git commit` in that
directory is aborted with the evidence printed in front of you.

Then see the boundary of what WhyGuard claims:

```bash
npx whyguard demo --scenario timeouts
```

Same tool, same kind of change, different answer. A repository where nobody recorded why a
timeout and a retry count were chosen: the same two commits score `HIGH`, risk 70, and only
**warn**. Write the decision down and the identical diff becomes `CRITICAL`, risk 94.5, and a
**block**. `whyguard demo --list` shows every scenario.

## Install

```bash
npm install -g whyguard
```

Requires Node.js 22.5+ and `git` on `PATH`. TypeScript/JavaScript only.

## Protect a repository

```bash
whyguard init --repo /path/to/your/project
```

One command installs every guardrail: the Git `pre-commit` hook, the Kiro `PreToolUse`/`Stop`
hooks, the MCP server configuration, and a rationale-contract template. It is idempotent,
merges into existing config files, and refuses to replace files it did not generate.

## Commands

| Command | What it does |
|---|---|
| `whyguard demo [--scenario payments\|timeouts]` | Self-contained walkthrough; `--list` for all scenarios |
| `whyguard init` | Wire every guardrail into a repository |
| `whyguard scan --base <ref> --head <ref>` | Analyze a Git range for changes that remove protected behavior |
| `whyguard trace <file>:<symbol>` | Reconstruct what is known about a symbol before you change it |
| `whyguard verify --scope staged\|working-tree` | Check uncommitted work; exits 2 when something blocks |
| `whyguard install-hooks` | Install only the Git `pre-commit` hook |
| `whyguard guard --stdin` / `whyguard hook` | Evaluate a single proposed edit (used by the Kiro hook) |

Run `whyguard` with no arguments for the full option list.

## The layers are not equally strong

This matters more than any feature, because treating them as equivalent is how you end up
with a false sense of safety:

| Layer | Who enforces it | Can an agent ignore it? |
|---|---|---|
| Git `pre-commit` | **Git aborts the commit itself** | **No** |
| GitHub PR Check | GitHub, server-side | **No** |
| Kiro `PreToolUse` | The IDE, by prompting you to confirm | Not the prompt, but it is a prompt |
| Kiro `Stop` | Nobody — it reports what already happened | It is a report, not a gate |

A `PreToolUse` hook that merely exits non-zero is *advisory*. Tested with two different
models, both applied a protected-behavior-removing edit after receiving the block. That is
why the hook returns a permission decision so the IDE asks a human, and why the Git hook
exists at all.

The human override is deliberate and visible:

```bash
WHYGUARD_SKIP=1 git commit -m "removing this on purpose"
```

The goal is not to make removal impossible. It is to make it impossible **by accident**.

## Write down a decision

**This is the one input WhyGuard needs from you.** A confirmed rationale contract is the only
source of `strong` evidence in the pipeline, and the block rule requires strong evidence — so
without one, WhyGuard reports and explains but never refuses a commit. That is deliberate:
blocking someone's work based on a guess about a commit message would not survive contact
with a real team.

```yaml
# .whyguard/decisions/payment-idempotency.yml
id: payment-idempotency
version: 1
status: active
scope:
  files: [src/payments/create-order.ts]
  symbols: [createOrder]
reason: >
  Clients retry checkout when the gateway times out, so without a guard a retry
  creates a second order and charges the customer twice.
must_preserve:
  - One idempotency key creates at most one order.
evidence:
  - { type: issue, id: "481" }
required_tests: [tests/payments/idempotency.test.ts]
```

`whyguard init` seeds a commented template at `.whyguard/decisions/EXAMPLE.yml`. Every field,
what it changes, and the commit-message conventions that make evidence stronger are covered in
[Feeding WhyGuard](https://github.com/rosselps/whyguard/blob/main/docs/guides/feeding-whyguard.md).

`required_tests` is the escape route: if a listed file exists, WhyGuard stops blocking and
downgrades to a warning. It never runs or parses the test — it takes the contract's word.

## What it detects

Guard clauses and early returns that disappear, validation calls that are removed,
comparison boundaries that move (`<` to `<=`), retry counts that drop or retry wrappers that
are deleted, and timeout/delay values that change.

Renaming a variable, reformatting, adding parentheses, strengthening a validation, or
*raising* a retry count are deliberately **not** findings.

WhyGuard also does not read your comments or JSDoc. Detection is purely structural, so a
detailed comment above a function documents it for humans but does not protect it.

## Optional: model-written explanations

Explanations are deterministic by default and require no network access. To use Amazon
Bedrock instead, install the SDK and opt in:

```bash
npm install @aws-sdk/client-bedrock-runtime
export WHYGUARD_LLM_ENABLED=true AWS_REGION=us-east-1 BEDROCK_MODEL_ID=<model>
```

The SDK is an optional peer dependency, so it is not downloaded unless you ask for it. A
model never decides whether to block — it only summarizes evidence WhyGuard already gathered.

## License

MIT
