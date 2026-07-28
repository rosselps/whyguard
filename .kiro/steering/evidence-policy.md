---
inclusion: auto
name: historical-decision-safety
description: Apply when modifying conditions, retries, timeouts, validation, payments, dates, compatibility workarounds, or regression tests.
---

# Evidence policy

Never claim a historical reason without citing evidence ids. Never invent an incident, an
issue, or a reason — if the evidence is insufficient, return `reasonStatus: "unknown"` with
low confidence and say manual review is required.

## Strength

| Strength | What earns it |
|---|---|
| `strong` | An `active` rationale contract covering this file and symbol |
| `medium` | A commit message with a closing keyword (`fixes #212`), or a declared regression test that exists on disk |
| `weak` | A bare `#212` mention, or the introducing commit with no explanation |

A confirmed contract is the only producer of `strong`. That is what makes it the only thing
that can cause a block.

## Confidence

The **strongest** item sets the score, plus 5 per corroborating non-weak item. Never the
average: averaging punished corroboration, so finding more evidence made WhyGuard block
less.

## Block rule

Block only when all of these hold: risk >= 80, confidence >= 75, at least one `strong`
item, a protected property is stated, the change removes or weakens it, and no equivalent
regression test exists. Otherwise warn or allow.
