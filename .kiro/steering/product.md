---
inclusion: always
---

# WhyGuard — Product

WhyGuard stops developers and coding agents from deleting historical technical decisions
hidden in source code. It reconstructs *why* a behavior exists from Git history, pull
requests, issues and recorded decisions, then reports or blocks a change that would erase
it.

It does not protect lines for being old. It protects the **behavioral property** the code
was introduced to preserve, so a refactor that keeps the property is fine.

## Category

Not "an AI code reviewer with repository context". The category is **decision provenance
and historical behavior protection**: why did this behavior exist, what property did it
protect, does the new change preserve it.

## The rule that shapes everything

Only a decision a human wrote down can block. A confirmed contract in
`.whyguard/decisions/*.yml` is the only source of `strong` evidence, and the block rule
requires strong evidence. Git history alone produces accurate warnings and no enforcement,
deliberately — refusing a commit based on a guess about a commit message would get the tool
uninstalled.

## Surfaces, all implemented

- CLI: `demo`, `init`, `scan`, `trace`, `verify`, `guard`, `hook`, `install-hooks`
- Kiro: `PreToolUse` hook returning a `permissionDecision`, `Stop` hook, MCP server
- Git `pre-commit` hook — the layer no agent can ignore
- GitHub App publishing a Check Run on a pull request
- Read-only dashboard over the API

## Out of scope

- Languages other than TypeScript and JavaScript
- Replacing human review, or proving causality
- Modifying production code autonomously
- A VS Code or Kiro IDE extension
- Jira, Slack, Linear, Notion integrations
