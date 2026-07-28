---
name: create-rationale-contract
description: Write a `.whyguard/decisions/*.yml` rationale contract for a confirmed protected property, so future changes can be checked against an explicit, owned decision instead of re-deriving history each time.
compatibility: Requires write access to `.whyguard/decisions/`. Registering a decision through the (planned) MCP `register_decision` tool always requires human confirmation — never auto-approve it.
---

## When to use this skill

After a `Finding`'s protected property has been reviewed and confirmed by a human (not just
proposed by the deterministic scan), capture it as a durable rationale contract so the next
agent or reviewer does not have to re-trace the same history.

## Workflow

1. Confirm the finding has moved from `proposed` to `confirmed` state (see
   `.kiro/steering/evidence-policy.md`) with a human actor recorded.
2. Create a new file at `.whyguard/decisions/<short-slug>.yml` following this shape:
   ```yaml
   id: <short-slug>
   version: 1
   status: active
   scope:
     files:
       - <path/to/file.ts>
     symbols:
       - <symbolName>
   reason: >
     <one or two sentences describing the real-world incident or requirement>
   must_preserve:
     - <explicit behavioral property, phrased as an invariant>
   evidence:
     - type: issue
       id: "<number>"
     - type: pull_request
       id: "<number>"
   required_tests:
     - <path/to/regression-test>
   expires_when:
     - <condition under which this decision no longer applies>
   owners:
     - <team-or-individual>
   ```
3. Do not mark `status: active` unless a human has actually confirmed the property; if in
   doubt, leave it as a draft and ask.
4. Link the contract's `id` back to the originating finding for traceability.
5. If a decision is later superseded, set `status: replaced` or `status: expired` — do not
   delete the file; history matters as much for decisions as for code.

## Anti-patterns to avoid

- Auto-generating a rationale contract straight from an unconfirmed `proposed` finding.
- Writing a vague `must_preserve` statement (e.g., "keep it safe") instead of a checkable
  invariant (e.g., "one idempotency key creates at most one order").
- Omitting `evidence` — a contract without evidence IDs cannot be audited later.
