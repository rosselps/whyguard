---
inclusion: auto
name: demo-constraints
description: Apply when working on the demo command, fixtures, or the recorded walkthrough.
---

# Demo constraints

`whyguard demo` is how anyone first sees the tool, so it has to hold up without an account,
a server, or a repository of the reader's own.

- Build a repository whose Git history **genuinely contains** the decision. Never fabricate
  evidence to make a demo look better — that is the one failure mode this product cannot
  afford, and a hardcoded fixture already had to be removed from the production path once.
- Two scenarios, not one. `payments` shows enforcement; `timeouts` shows the boundary,
  where the same diff only warns until a decision is written down. A demo that always
  blocks teaches the wrong lesson.
- Every claim the narration makes must be asserted by a test, so the words cannot drift
  from the behavior.
- Refuse a non-empty target directory unless `--force`. The fixture builders delete what is
  there.
- Never persist to the shared database. A demo should not leave a `data/whyguard.db` in
  whatever directory the reader was standing in.
