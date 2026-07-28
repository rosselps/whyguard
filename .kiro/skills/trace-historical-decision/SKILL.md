---
name: trace-historical-decision
description: Trace why a code condition, constant, retry, timeout, validation, compatibility workaround, or regression test exists. Use before removing or simplifying suspicious historical code.
compatibility: Requires git. Uses the WhyGuard CLI (`whyguard scan`) as the deterministic core; the MCP server described below is planned but not implemented yet.
---

## When to use this skill

Before removing, simplifying, or "cleaning up" a condition, guard clause, retry, timeout,
validation call, or special-case branch — especially in payments, auth, orders, dates, or
external-API code — trace why it exists first.

## Workflow

1. Identify the exact file, symbol, and changed lines you are about to touch.
2. Run the deterministic scan against the relevant commit range:
   ```bash
   pnpm whyguard scan --base <base-ref> --head <head-ref> --format json
   ```
   (Today this is the CLI vertical slice; once the MCP server ships, prefer calling
   `whyguard.trace_symbol` instead.)
3. Review every evidence ID and its strength (`strong` / `medium` / `weak`) — never treat
   evidence as reliable without checking strength.
4. State the protected behavior separately from the current implementation. Example:
   "protects: one idempotency key creates at most one order" vs. "implemented via: an
   early-return guard checking a Map".
5. If evidence is weak or absent, say explicitly that the reason is unknown. Do not invent
   an incident, issue, or justification.
6. Propose a regression test that encodes the protected behavior before suggesting removal
   or replacement of the historical code.

## Anti-patterns to avoid

- Removing a guard clause because it "looks redundant" without running a trace first.
- Citing an issue/PR number from memory instead of the evidence returned by the tool.
- Treating `weak` evidence as if it were `strong`.
- Concluding "no evidence found" without checking the introducing commit via `git log -S`.
