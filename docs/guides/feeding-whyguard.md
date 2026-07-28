# Feeding WhyGuard

Everything WhyGuard knows comes out of your repository. This is the complete list of what it
reads, what each input changes, and which conventions are worth adopting.

## The one rule that explains everything else

**Only a decision a human wrote down can block a change.**

WhyGuard grades evidence in three strengths, and the block rule requires at least one
`strong` item. Exactly one thing in the pipeline produces `strong`:

| What WhyGuard found | Strength | Enough to block? |
|---|---|---|
| An `active` rationale contract covering the file and symbol | `strong` | **Yes** |
| A commit message with a closing keyword (`fixes #212`) | `medium` | No |
| The commit that introduced the code, message says nothing | `weak` | No |
| A bare `#219` mention with no closing keyword | `weak` | No |
| A regression test the contract declares, present on disk | `medium` | No — it *prevents* blocking |

So a repository with good commit hygiene and no contracts gets accurate warnings and no
enforcement. That is deliberate: refusing someone's commit based on a guess about a
commit message would burn the tool's credibility in a week.

You can watch the transition happen on one repository:

```bash
npx whyguard demo --scenario timeouts
```

Same two commits, scanned twice. Before the decision file exists, and after:

| | Severity | Risk | Confidence | Decision |
|---|---|---|---|---|
| Git history only | HIGH | 70 | 65 | warn |
| Plus the recorded decision | CRITICAL | 94.5 | 100 | **block** |

## Everything WhyGuard reads

Four inputs. Nothing else.

### 1. The code itself, as a syntax tree

`packages/ast-adapter` parses the before and after versions with `ts-morph` and compares
structure. It detects five patterns:

| Pattern | What it means | Weight |
|---|---|---|
| `condition_removed` | A guard clause with an early exit disappeared | 85 |
| `validation_removed` | A validation call disappeared | 75 |
| `retry_removed` | A retry count dropped, or a retry wrapper was deleted | 70 |
| `boundary_changed` | A comparison operator moved (`<` to `<=`) | 55 |
| `timeout_changed` | A named duration value changed | 50 |

Deliberately **not** findings: renaming identifiers, reformatting, adding redundant
parentheses, and *raising* a retry count. A guardrail that fires on a rename gets
uninstalled, and then it protects nothing.

**WhyGuard does not read your comments.** Not line comments, not JSDoc, not the
`Historical context (Issue #481 / PR #493)` block in the demo fixture. Nothing in the
pipeline touches a comment node. If you delete every comment in the repository,
detection is unaffected — and writing a detailed comment above a function does not
protect it. Comments help the next human; they are invisible to the tool.

### 2. Commit messages, via the introducing commit

WhyGuard runs a pickaxe search (`git log -S`) scoped to the changed file to find the
commit that *introduced* the logic being removed — not the last commit that touched the
line, which is what `git blame` would give you. Then it reads that commit's message.

This is where commit conventions pay off, and the rule is narrow enough to state exactly:

```
fixes #212       -> medium   (closing keyword)
closes #212      -> medium
resolved #212    -> medium
see #219         -> weak     (a mention, not a claim)
#219             -> weak
```

The recognized keywords are `close`, `closes`, `closed`, `fix`, `fixes`, `fixed`,
`resolve`, `resolves`, `resolved`, each followed by `#<number>`.

Practical consequence: **write why in the commit that adds the protection, and use a
closing keyword.** A commit message like

```
Retry warehouse inventory sync with a 30s timeout (fixes #212)

The provider returns 504 under load, which silently dropped batches and
left stock counts drifting. Closes #212. See PR #219.
```

gives WhyGuard a `medium` trail years later. A message like `fix sync` gives it `weak`,
and the finding reads "no reliable historical reason was found".

### 3. Rationale contracts — `.whyguard/decisions/*.yml`

The only input that unlocks enforcement. `npx whyguard init` seeds a commented template
at `.whyguard/decisions/EXAMPLE.yml` (inactive, so it can never guard anything by
accident).

Field by field, with what each one actually does:

```yaml
id: inventory-sync-resilience
version: 1
status: active
```

`status` must be `active`. `draft`, `replaced`, and `expired` contracts are loaded and
visible but never matched — which is how you park a decision without deleting its
history.

```yaml
scope:
  files:
    - src/logistics/sync-inventory.ts
  symbols:
    - syncInventory
```

Matching is suffix-based on the path, so `src/logistics/sync-inventory.ts` also matches
a repository that nests the project deeper. If `symbols` is present, the changed symbol
must be in the list; omit `symbols` to cover the whole file. A contract match also
raises the module-criticality factor to at least 90, on the reasoning that a human
scoping a decision to a file says more about its importance than any path heuristic.

```yaml
reason: >
  The warehouse provider returns 504 under load. Without retries and a generous
  timeout, inventory batches are silently dropped and stock counts drift.
```

Shown verbatim in the Check Run, the CLI output, the block message, and the dashboard.
Write the incident, not the implementation. This is the sentence a stranger reads at the
moment they are about to delete your code.

```yaml
must_preserve:
  - Inventory batches are retried at least 3 times before being reported as failed.
  - The request timeout stays at or above 30 seconds.
```

These become the finding's protected properties, with status `confirmed` instead of
`proposed`. State them as **observable behavior**, never as "keep these lines" — the
whole point is that a rewrite preserving the property is fine.

```yaml
evidence:
  - type: issue
    id: "212"
  - type: pull_request
    id: "219"
```

Each entry becomes a `strong` evidence item. Quote the ids: YAML would otherwise read
`212` as a number and the schema expects a string. More `issue` entries also raise the
repeated-incident factor, on the reasoning that a behavior that broke twice is more
likely to break again.

```yaml
required_tests:
  - tests/logistics/sync-inventory.test.ts
```

**Load-bearing, and the escape route from a block.** If a listed path exists in the
repository, WhyGuard emits a `test` evidence item and stops blocking — the change is
still reported as a warning, but Git no longer aborts your commit.

Be clear about what this does and does not mean. WhyGuard does not run the test, parse
it, or measure coverage. It takes the contract's word that this file proves the property.
Claiming to verify that would be a much bigger promise than the tool can keep, and a
guardrail that silently mis-verifies is worse than one that is explicit about trusting
you.

```yaml
expires_when:
  - The warehouse provider publishes an SLA that rules out 504 responses under load.
owners:
  - logistics-team
```

Honest limitation: `expires_when` and `owners` are parsed, stored, and displayed, but
nothing scores them yet. Write `expires_when` anyway — protection that can never expire
becomes technical debt nobody dares touch, and the field is where the exit condition
lives for the human who eventually revisits it.

### 4. Test files named by `required_tests`

Existence only. See above.

## What moves the score

The risk score is a fixed weighted sum. This is the whole formula:

```
risk = 0.25 * moduleCriticality       path heuristic, or >= 90 with a contract
     + 0.20 * historicalSeverity      100 with a contract, 90 with strong evidence
     + 0.20 * evidenceStrength        strongest item + 5 per corroborating item
     + 0.15 * missingRegressionTest   100 unless a required_tests file exists
     + 0.10 * semanticChangeMagnitude the per-pattern weight in the table above
     + 0.10 * repeatedIncidentSignal  100 for 2+ issues, 50 for one
```

Severity: `>= 80` critical, `>= 60` high, `>= 35` medium. A block additionally needs
confidence `>= 75`, strong evidence, a protected property, and no equivalent regression
test.

`moduleCriticality` comes from the file path, which is a heuristic and labelled as one:

| Path contains | Score |
|---|---|
| `payment`, `payments`, `billing`, `auth`, `order`, `orders` | 90 |
| `logistics`, `schedul`, `timezone`, `date`, `rounding` | 60 |
| anything else | 30 |

Do not rename directories to game this. Write a contract instead — it overrides the
heuristic, and it also tells the next human something true.

## Conventions worth adopting

Ordered by return on effort.

1. **Write a contract for behavior that came from an incident.** Not for everything.
   The test is: would a stranger reading this code delete it? If yes, and deleting it
   caused an outage once, write it down. Ten good contracts beat two hundred generated
   ones.
2. **Use closing keywords in the commit that adds the protection.** `fixes #212`, in the
   commit that adds the guard, is the cheapest permanent improvement available. It costs
   nothing and it is what the pickaxe finds years later.
3. **Explain the incident in the commit body.** WhyGuard shows this text to whoever is
   about to change the code. One sentence about the failure mode is worth more than a
   paragraph about the implementation.
4. **List the regression test in the contract.** It is how safe refactors get through
   without anyone reaching for `--no-verify`.
5. **Phrase `must_preserve` as behavior.** "One idempotency key creates at most one
   order", not "keep the early return".
6. **Give every contract an `expires_when`.** Even an unlikely one.
7. **Run `whyguard trace <file>:<symbol>` before touching unfamiliar code.** Most of the
   value is in knowing, not blocking.

## Anti-patterns

- **A contract per function.** Scope creeps, everything becomes critical, and the block
  message stops carrying information. Protect properties, not lines.
- **Over-broad scope.** A contract covering `src/` matches every change in the project
  and forces criticality to 90 everywhere. Name the file.
- **`must_preserve` written as implementation.** "Keep the `if (existing)` check" blocks
  the refactor that would have been fine.
- **Listing a `required_tests` file that does not exist.** Silently ignored, so the
  escape route the block message offers will not work and nobody will know why.
- **Renaming directories to raise criticality.** Fragile, dishonest, and a contract does
  it better.
- **Deleting a contract when the decision stops applying.** Set `status: expired` and
  fill in `expires_when` instead. The next person deserves to know it used to matter.

## Checklist

Before relying on WhyGuard in a repository:

- [ ] `npx whyguard init` has been run, and the Git pre-commit hook exists
- [ ] At least one `active` contract exists, scoped to a real file and symbol
- [ ] Each contract's `must_preserve` reads as observable behavior
- [ ] Each contract's `evidence` ids are quoted strings
- [ ] Each contract's `required_tests` paths actually exist, or are known to be pending
- [ ] The team knows `WHYGUARD_SKIP=1 git commit` is the visible override, and that
      using it is a signal to update the contract

## Where this is implemented

If you want to read the code rather than trust this document:

| Behavior | File |
|---|---|
| Pattern detection, cosmetic-change filtering | `packages/ast-adapter/src/detector.ts` |
| Evidence sources and strengths | `packages/application/src/evidence-gathering.ts` |
| Commit message parsing | `packages/application/src/commit-message-evidence.ts` |
| Contract loading and scope matching | `packages/application/src/rationale-contracts.ts` |
| Risk, confidence, severity, block rule | `packages/domain/src/risk.ts` |
| Module criticality heuristic | `packages/application/src/module-criticality.ts` |
| Contract schema | `packages/contracts/src/schemas.ts` |
