---
inclusion: always
---

# WhyGuard — Tech stack

- TypeScript strict, Node >= 22.5 (repo pins Node 24 via `.node-version`).
- pnpm workspaces, Turborepo, Vitest, Prettier, ESLint.
- Zod (`packages/contracts`) for every DTO crossing a boundary.
- `ts-morph` for AST comparison (`packages/ast-adapter`).
- Git through `child_process` with argument arrays only (`packages/git-adapter`).
- `node:sqlite` (`DatabaseSync`) for persistence. Chosen over `better-sqlite3` to avoid a
  native build step on contributors' machines. Still an experimental Node API — if it
  becomes a blocker, revisit deliberately rather than swapping libraries quietly.
- Octokit for the GitHub App, Amazon Bedrock for optional explanations, MCP SDK for the
  server, Vite + React + Tailwind for the dashboard.
- CLI presentation: `picocolors` and `yocto-spinner`. Boxes and tables are hand-written to
  keep the published bundle small and the ASCII fallback consistent.

## Standards

- No `any` without a comment explaining the boundary.
- Validate every external input and all model output with Zod before trusting it.
- Domain errors are typed and serializable.
- Formatting is Prettier's job. Run `pnpm format`, do not hand-align.
- A comment explains *why*, briefly. Do not narrate what the code already says, and do not
  cite documents a reader of this repository cannot open.
