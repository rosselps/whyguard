---
name: review-evidence-quality
description: Assess whether historical evidence (issues, PRs, commits, comments, tests) actually supports a claimed protected property before trusting or citing it. Use whenever a WhyGuard finding or agent claims a historical reason for code.
compatibility: No external tools required beyond reading the evidence items themselves.
---

## When to use this skill

Whenever a `Finding` or another agent claims "this code exists because of X" — verify the
claim against the evidence-strength rubric in `.kiro/steering/evidence-policy.md` before
accepting it.

## Evidence strength rubric

| Strength | Criteria |
|---|---|
| Strong | A PR/issue/comment explicitly names the symbol and protected behavior, or a regression test clearly represents it. |
| Medium | A commit message and code/test changes strongly imply the behavior, without explicit confirmation. |
| Weak | Only a temporal or semantic correlation exists, with no explicit explanation. |

## Workflow

1. Read every evidence item's `type`, `title`, `summary`, and `strength` — not just its ID.
2. Confirm the evidence actually references the same symbol/file/behavior under review, not
   a superficially similar one.
3. Downgrade your trust in the finding if:
   - the only evidence is `weak`;
   - the evidence references a different function or file than the one being changed;
   - the evidence is a commit message alone with no linked issue/PR/test.
4. Never let an LLM-authored summary substitute for reading the actual evidence item.
5. If evidence is insufficient, explicitly report `reasonStatus: unknown` and recommend
   manual review — do not fabricate a plausible-sounding justification.

## Anti-patterns to avoid

- Accepting a `riskScore`/`confidenceScore` at face value without checking which evidence
  strengths fed into it.
- Merging evidence from an unrelated finding because the file path looks similar.
- Treating the absence of a search result as proof that no incident occurred (weak evidence
  is not the same as evidence of safety).
