---
name: generate-regression-fixture
description: Turn a WhyGuard finding's protected property into a reviewable regression-test skeleton before a sensitive historical-decision change is merged or replaced. Use after a finding has a confirmed or proposed protected property and before removing/simplifying the code it covers.
compatibility: Requires a recorded Finding in the current WhyGuard session (via `whyguard scan`, `whyguard guard`, or the MCP `whyguard.scan_diff`/`whyguard.trace_symbol` tools). Uses `whyguard.propose_regression_test` (MCP) or `proposeRegressionTest` (application layer) as the deterministic generator — no LLM is involved in this phase.
---

## When to use this skill

After WhyGuard reports a finding whose protected property should survive a refactor,
and before that refactor is merged — generate a regression-test skeleton that encodes
the protected behavior, so a reviewer has something concrete to check instead of a
prose description alone.

## Workflow

1. Identify the finding ID (from `whyguard scan --format json`, `whyguard guard`, or an
   MCP `whyguard.scan_diff` / `whyguard.trace_symbol` response).
2. Call `whyguard.propose_regression_test` with that `findingId` and the project's test
   framework (defaults to `vitest`).
3. Read the returned skeleton. It will contain:
   - the protected property statement(s), as comments;
   - the supporting evidence IDs and strengths, as comments;
   - a single `it.todo(...)` naming the property — deliberately not a working
     assertion.
4. A human fills in the real assertion, using the protected property statement as the
   spec for what to assert (e.g. "one idempotency key creates at most one order" becomes
   an assertion that calling the function twice with the same key produces one order).
5. Never execute the generated skeleton automatically, and never treat `it.todo` as
   passing — it is a placeholder, not evidence of coverage.
6. Once the test is written and passing against the *old* behavior, only then consider
   the refactor. If the refactor needs to change the assertion itself, that is a signal
   the protected property may be intentionally changing — get that confirmed by a human
   and update the rationale contract (see `create-rationale-contract`) rather than
   silently loosening the test.

## Anti-patterns to avoid

- Treating the generated `it.todo` skeleton as if it were a real, passing test.
- Writing an assertion that only encodes "the current code's behavior" instead of the
  protected property (e.g. asserting the exact implementation detail rather than the
  invariant it's meant to guarantee).
- Skipping this skill because a change "seems obviously safe" — the finding's risk and
  confidence scores exist precisely to flag when it is not.
- Running or auto-approving execution of the generated test file without human review.
