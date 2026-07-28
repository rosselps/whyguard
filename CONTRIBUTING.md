# Contributing to WhyGuard

Coding standards, architecture principles, and the Git workflow. Product scope and
architecture decisions live in [`AGENTS.md`](./AGENTS.md) and
[`.kiro/steering/`](./.kiro/steering/); this document never contradicts them.

## Architecture principles

- **Modular monolith, ports and adapters.** `domain` has zero infrastructure imports.
  `application` depends only on `domain` and port interfaces. Adapters (`git-adapter`,
  `ast-adapter`, and future `github-adapter` / `llm-adapter` / `persistence-adapter`)
  implement those ports. Apps (`cli`, and future `api` / `worker` / `mcp-server` /
  `dashboard`) compose use cases and adapters — they contain no business logic themselves.
- **Determinism first.** Prefer Git/AST logic over LLM calls. Nothing in `domain`,
  `application`, `git-adapter`, or `ast-adapter` may call an LLM or make a network request.
- **DTOs are contracts.** Any value crossing a package or process boundary is defined and
  validated with a Zod schema in `packages/contracts`. Do not pass ad hoc object shapes
  between packages.
- **Evidence discipline.** Never assert a historical reason without citing evidence IDs.
  Weak evidence must never produce a `critical`/high-confidence finding on its own.

## Coding standards

- TypeScript strict mode is on everywhere (`tsconfig.base.json`). Do not weaken it per
  package.
- No `any` without a comment explaining the boundary reason. ESLint warns on
  `@typescript-eslint/no-explicit-any`; treat the warning as something to justify or fix,
  not silence.
- No raw `child_process`/shell Git commands outside `packages/git-adapter`. Always use
  argument arrays, never string-concatenated commands.
- No direct Octokit/GitHub API calls outside a future `github-adapter`.
- No LLM/model calls outside a future `llm-adapter`.
- Validate all external input (CLI args, file content, future HTTP/webhook payloads) and
  any LLM output against a Zod schema before trusting it.
- Public functions get a short TSDoc comment when their behavior isn't obvious from the
  signature — explain *why*, not *what*, when the *what* is already clear from the code.
- Formatting is delegated entirely to Prettier — do not hand-format code or argue about
  style in review; run `pnpm format` instead.

## Tooling

```bash
pnpm install       # install workspace dependencies
pnpm build          # build all packages (turbo)
pnpm typecheck      # tsc --noEmit across all packages
pnpm lint           # ESLint across the whole repo
pnpm lint:fix       # ESLint with --fix
pnpm format         # Prettier --write across the whole repo
pnpm format:check   # Prettier --check (used in CI / pre-commit)
pnpm test           # vitest across all packages
```

A pre-commit hook (Husky + lint-staged) automatically runs ESLint and Prettier on staged
files. A commit-msg hook (commitlint) enforces Conventional Commits. Both run locally on
every commit — there is no way to skip them silently, and `--no-verify` should only be used
in the rare case you and the reviewer have explicitly agreed to it.

## Commit conventions

This repository uses [Conventional Commits](https://www.conventionalcommits.org/):

```text
<type>(<optional scope>): <short summary>

[optional body]

[optional footer(s)]
```

Common types: `feat`, `fix`, `refactor`, `test`, `docs`, `chore`, `build`, `ci`, `perf`.

Examples:

```text
feat(ast-adapter): detect removed retry-count changes
fix(git-adapter): validate SHA before shelling out to git blame
docs(readme): document the demo fixture workflow
```

Scope should generally match the package or app you changed (`domain`, `git-adapter`,
`cli`, `contracts`, etc.).

## Testing expectations

- Every new detector pattern or risk rule needs a unit test.
- Every use case in `packages/application` that touches multiple adapters needs at least
  one integration test using a real fixture (see `packages/test-fixtures`), not mocks of
  the adapters it's supposed to integrate.
- Tests must not depend on wall-clock time, real network calls, or hidden global state.
  Inject a `now()` function or fixed IDs where determinism matters (see
  `packages/domain/src/finding-state.ts` for the pattern).

## Before opening a PR

1. `pnpm build && pnpm typecheck && pnpm lint && pnpm test` all pass locally.
2. No unapproved scope was added (see the MVP boundary in
   `.kiro/steering/product.md` and `.kiro/steering/demo-constraints.md`).
3. No secret, token, or `.env` file is staged.
4. Documentation/steering is updated if you changed architecture or added a package.
