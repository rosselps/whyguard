---
inclusion: always
---

# WhyGuard — Structure and dependency rules

```text
apps/
  cli/                   demo, init, scan, trace, verify, guard, hook, install-hooks
  mcp-server/            6 MCP tools; 1 write tool, confirmation-gated
  api/                   GitHub webhooks + Check Runs + read-only dashboard API
  dashboard/             Vite + React investigation UI
packages/
  contracts/             Zod schemas / shared DTOs
  domain/                risk + confidence formulas, block rule, state transitions
  application/           scan-diff, trace-symbol, guard-change, verify-uncommitted-work,
                         scan-pull-request, evidence-gathering, workspace-cleanup
  git-adapter/           argument-array Git wrappers, local and remote
  github-adapter/        App auth, PR reads, Check Runs, webhook signature verification
  ast-adapter/           ts-morph sensitive-change detector
  llm-adapter/           Bedrock + schema validation + deterministic fallback
  persistence-adapter/   SQLite (node:sqlite)
  test-fixtures/         demo repository builders
.kiro/
  settings/mcp.json      template wiring apps/mcp-server into a target workspace
  hooks/                 PreToolUse and Stop hook artifacts
.whyguard/decisions/     rationale contracts — these live in the repository being analyzed
```

## Dependency rules

1. `domain` imports no infrastructure.
2. `application` depends on `domain` and port interfaces only.
3. Adapters implement ports; apps compose use cases and adapters and hold no business logic.
4. CLI, MCP server and API reuse the same `application` services. Never duplicate a rule
   across surfaces — a finding from a Git hook and one from a pull request must carry the
   same scores.
5. DTOs crossing a boundary live in `contracts` and are Zod-validated.
6. `test-fixtures` never reaches a production decision. It is bundled for `whyguard demo`
   and nothing else consults it.
7. Finding assembly and evidence gathering live in `finding-builder.ts` and
   `evidence-gathering.ts`. Do not re-derive risk or evidence rules elsewhere.
8. No Octokit outside `github-adapter`.
9. No `node:sqlite` outside `persistence-adapter`, which loads it lazily so Node's
   experimental warning does not prefix every command.
10. No model call outside `llm-adapter`.
11. Terminal presentation lives in `apps/cli/src/ui.ts`. `--format json` never passes
    through it.
