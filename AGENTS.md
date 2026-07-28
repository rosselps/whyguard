# AGENTS.md

Development context for any coding agent working in this repository. Kiro and compatible agents load it automatically, alongside `.kiro/steering/`.

Where the detail lives:

| Topic | File |
|---|---|
| What the product is and is not | `.kiro/steering/product.md` |
| Components, pipeline, trust boundaries | `docs/architecture/architecture.md` |
| Evidence strength, confidence, block rule | `.kiro/steering/evidence-policy.md` |
| Package layout and dependency rules | `.kiro/steering/structure.md` |
| What the tool reads from a repository | `docs/guides/feeding-whyguard.md` |
| Coding standards and commit conventions | `CONTRIBUTING.md` |

## Operating rules

1. Read `.kiro/steering/` before proposing architecture changes.
2. Preserve the modular-monolith, ports-and-adapters boundary (`domain` → `application` → adapters → apps).
3. Do not add a new service, database, framework, or integration without an ADR.
4. Do not expand language support beyond TypeScript/JavaScript in the MVP.
5. Do not build an IDE extension.
6. Prefer deterministic Git/AST logic before LLM logic.
7. Never claim a historical reason without evidence IDs.
8. Distinguish protected behavior from current implementation.
9. Never auto-execute generated tests.
10. Keep GitHub permissions minimal — Contents/Pull requests/Issues/Metadata Read, Checks Read & Write only. Never request Contents Write for the App.
11. Keep the CLI functional as a fallback — it remains a first-class surface alongside the MCP server.
12. Include tests for every new detector or risk rule.
13. Return `unknown` when evidence is weak; never invent an incident, issue, or reason.
14. Do not weaken webhook, path, command, or secret-handling controls.
15. Before finishing a task, run `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, and relevant tests.
16. The `.kiro/settings/mcp.json` and `.kiro/hooks/*.template` files in this repo are templates for a *target* workspace being protected by WhyGuard — never register a live PreToolUse hook against WhyGuard's own repository.

## Implementation record

What is built and how it was verified. Nothing is marked done until it has actually been
demonstrated, not just because the code exists.

### Phase 0 — Scope and fixtures — DONE

- [x] Frozen scope (this document + `.kiro/steering/product.md`).
- [x] Monorepo skeleton (`apps/`, `packages/`, `.kiro/`, `.whyguard/`).
- [x] Controlled demo repository with believable history (`packages/test-fixtures`,
      plus the real `rosselps/downmusic` GitHub repo used for live Phase 3 validation).
- Exit criterion met: the payment-idempotency incident can be demonstrated manually
  from fixtures.

### Phase 1 — Deterministic core — DONE

- [x] Git workspace abstraction (`packages/git-adapter`).
- [x] Diff reader and AST detector for sensitive-change patterns (`packages/ast-adapter`).
- [x] History tracing, domain contracts (`packages/domain`, `packages/contracts`).
- [x] CLI JSON output (`whyguard scan`, `apps/cli`).
- Exit criterion met: `whyguard scan` returns the payment finding from a local fixture
  without an LLM.

### Phase 2 — Evidence and risk — DONE

- [x] Evidence graph and gathering (`packages/application/src/evidence-gathering.ts`).
- [x] Risk/confidence engine (`packages/domain/src/risk.ts`).
- [x] Unknown-reason behavior (`reasonStatus: "unknown"` throughout).
- [x] Rationale contract schema and loader (`.whyguard/decisions/*.yml`,
      `packages/application/src/rationale-contracts.ts`).
- Exit criterion met: every finding carries evidence IDs and reproducible sources;
  weak evidence alone never produces a high-confidence block (see `guard-change.test.ts`).

### Phase 3 — GitHub product surface — DONE

- [x] GitHub App auth and API calls (`packages/github-adapter`).
- [x] Webhook signature validation and delivery deduplication (`apps/api`).
- [x] Check Run publication (`scanPullRequest` use case).
- Exit criterion met and validated **live**: opening a real PR against
  `rosselps/downmusic` produced a visible WhyGuard Check
  (`https://github.com/rosselps/downmusic/runs/89359328330`).

### Phase 4 — Kiro integration — DONE

- [x] MCP server with the full section 14.4 tool table: `whyguard.scan_diff`,
      `whyguard.trace_symbol`, `whyguard.get_finding`, `whyguard.list_protected_properties`,
      `whyguard.propose_regression_test` (read-only), and `whyguard.register_decision`
      (write, gated behind an explicit `confirm: true` input — never auto-approved).
- [x] Workspace MCP config (`.kiro/settings/mcp.json`).
- [x] Four skills: `trace-historical-decision`, `review-evidence-quality`,
      `create-rationale-contract`, `generate-regression-fixture`.
- [x] Deterministic `PreToolUse` hook template (`.kiro/hooks/whyguard-guard.hook.json.template`)
      and CLI hook adapter (`whyguard hook`, `apps/cli/src/hook-adapter.ts`).
- [x] Agent context/steering (`AGENTS.md`, `.kiro/steering/*`) and custom agent
      (`.kiro/agents/whyguard-reviewer.md`).
- Exit criterion: "Kiro is blocked on the controlled payment edit and receives
  actionable evidence" — demonstrated deterministically via
  `guard-change.test.ts` ("blocks removing the idempotency guard..."). Wiring a live
  Kiro workspace to this hook against a *target* repository (not WhyGuard's own repo,
  per rule 16 below) is a deployment step for whoever adopts WhyGuard, not additional
  code in this repository.

### Phase 5 — Dashboard and explanation — COMPLETE

- [x] Persistence adapter (`packages/persistence-adapter`, SQLite via Node's built-in
      `node:sqlite`; see "Notes" below for why `better-sqlite3` was not used).
      Wired into `apps/api` (every completed PR scan is saved) and `apps/cli`
      (`whyguard scan` persists too, best-effort — a save failure never changes
      the CLI's exit code or output).
- [x] Repository/analysis/finding dashboard screens (`apps/dashboard`, Vite + React
      + TypeScript + Tailwind, wired to `GET /reports`/`GET /reports/:id`/
      `GET /decisions/:id` via TanStack Query). Four routes per the UI/UX spec:
      `/`, `/analyses/:analysisId`, `/decisions/:decisionId`,
      `/settings/integrations`. `apps/api`'s `createServer` now accepts a
      `dashboardOrigins` allow-list and reflects `Access-Control-Allow-Origin`
      only for those (defaults to `http://localhost:5173`) so the dashboard's
      dev server can call the API cross-origin — verified manually end-to-end
      with both dev servers running against real seeded data. `ActionBar`'s
      "Generar prueba" button is wired to `GET /findings/:id/regression-test` and
      renders the result in `RegressionTestPanel`; "Continuar con justificación"
      remains disabled with an explanatory tooltip (rationale-contract authoring
      UI is out of scope for the MVP dashboard). `DiffViewer` and
      `KiroGuardrailPanel` are not built (no diff/guardrail data source is wired
      to the dashboard API) — correctly out of Phase 5's canonical scope per
      section 23; they belong to the UI/UX spec's aspirational component list,
      not this phase's deliverables.
- [x] Bedrock explanation with schema validation (`packages/llm-adapter`).
      `explainFinding` validates the model's JSON output against
      `LlmExplanationSchema` and rejects any output that cites an
      `usedEvidenceIds` entry not present in the finding's own evidence — falls
      back locally on any validation, network, or parsing failure. The Bedrock
      invoker is only constructed when `WHYGUARD_LLM_ENABLED=true` **and**
      `AWS_REGION` **and** `BEDROCK_MODEL_ID` are all set (`apps/api/src/config.ts`,
      mirrored in `apps/cli/src/index.ts`); otherwise every explanation is the
      deterministic fallback, so the demo works with zero AWS configuration.
- [x] Deterministic fallback template when Bedrock is unavailable
      (`packages/llm-adapter/src/fallback.ts`). Every `LlmExplanation` carries a
      `source: "bedrock" | "fallback"` field that is never hidden — the dashboard's
      `HistoricalExplanation` component always shows a badge naming which path
      produced the text on screen.
- [x] Proposed regression test surfaced in the dashboard (reuses
      `whyguard.propose_regression_test`'s logic, refactored into a pure
      `buildRegressionTestProposal(finding, framework)` in
      `packages/application/src/propose-regression-test.ts` so `apps/api` can call
      it against a persisted finding without the in-memory finding-store).
      `GET /findings/:id/regression-test` (optional `?framework=`) backs the
      dashboard's "Generar prueba" button, implemented as a TanStack
      `useMutation` (never auto-fetched) that renders a `RegressionTestPanel`
      with a copy button only — no "Run" action, per the rule that WhyGuard never
      executes a generated test automatically.
- LLM explanations and regression-test proposals are persisted per finding
  (`packages/persistence-adapter`: additive `llm_explanation_json` column,
  `updateFindingLlmExplanation`, `getFindingById`) and included in
  `GET /reports/:id`'s finding DTOs (`AnalysisRunFindingWithExplanation`).
- Exit criterion met: the full demo (webhook or CLI scan → risk score, evidence,
  explanation, and a copyable regression-test proposal) is understood entirely
  from the dashboard, without reading terminal logs.

`apps/dashboard` must follow the canonical UI/UX spec at
`docs/design/ui-ux.md`
(mockups in the same folder; summarized for agents in `.kiro/steering/ui-ux.md`,
auto-loaded when editing files under `apps/dashboard/`). That spec's own recommended
stack is Next.js; this repo uses **Vite + React instead**, confirmed with the user as
an intentional, documented deviation (lighter weight, no SSR need for a local-only
tool) — not a silent substitution.

### Phase 6 — Hardening and release — IN PROGRESS

**Live Kiro hook re-verification (2026-07-26):** After fixing the two hook-adapter
bugs above (snake_case event shape, absolute-path resolution), re-tested the
guard live by replaying the exact `PreToolUse` event Kiro sends. Confirmed:
1. A real guard removal (`if (existing) return existing;` deleted) is blocked
   (`exit 2`, feedback with evidence) and the file is left untouched.
2. A cosmetic-only rename of the same guard's variable (`existing` ->
   `priorOrder`) was a **false positive** — blocked when it should have been
   allowed, because `compareGuardClauses` matched by raw condition text.
   Fixed in the same session (`fix(ast-adapter): ignore cosmetic identifier
   renames in guard clauses`) with an identifier-normalization signature;
   re-verified live afterward that the rename now allows (`exit 0`) while the
   real removal still blocks (`exit 2`).
3. Confirmed this class of hook is **not** automatically intercepted by a
   CLI/ACP-style agent session the way it is in Kiro IDE proper — the agent
   itself is responsible for invoking `.kiro/hooks/*.json` command actions
   before each write. This is a real deployment-mode difference to document
   for users, not a WhyGuard bug (see "Kiro integration modes" note below).

- [x] End-to-end tests covering the full demo script (section 21/31).
      `packages/application/src/demo-script.e2e.test.ts` composes the same
      deterministic use cases the CLI/MCP server/`apps/api` call individually
      (`scanDiff`, `guardChange`, `buildRegressionTestProposal`, `traceSymbol`)
      in the order the rehearsed demo exercises them: detect the idempotency
      removal with Issue #481/PR #493 evidence -> block the same edit via
      `guardChange` -> generate a regression-test proposal -> allow a safe
      cosmetic-only refactor -> a second scan on safe-to-safe produces zero
      findings. The GitHub Check/dashboard-rendering steps are intentionally
      not re-asserted here — they're already covered by `apps/api`'s route
      tests and were verified manually per Phase 5's entry above.
- [x] Cleanup and privacy verification pass. Audited and confirmed (no code
      changes were needed — every control below was already in place from
      earlier phases): `.env` has never been committed to git history and is
      gitignored; webhook signature verification uses HMAC-SHA256 with a
      constant-time comparison; `git-adapter` redacts credentials from clone
      URLs before they can appear in an error message; `apps/api`'s logger
      never logs secrets, only derived/redacted fields; no `console.log` of
      file or repository content exists anywhere in `apps/` or `packages/`;
      `llm-adapter`'s prompt is scoped to a single finding's data, never the
      whole repository; `.kiro/settings/mcp.json` and `.kiro/hooks/*.template`
      only contain placeholder env vars; `.tmp/` and `data/` are gitignored
      and contain no tracked files.
- [ ] Public deployment. **Deferred by user request** — do not deploy until
      Phase 6's remaining local validation is complete and confirmed. Platform
      (API host, dashboard host, GitHub App target) needs to be decided when
      this item is picked back up.
- [x] **Fabricated evidence removed from the production path.** `lookupEvidenceFixture`
      (Phase 1 scaffolding) injected two hardcoded `strong` evidence items —
      Issue #481 and PR #493, with `github.com/demo-org/...` URLs — for *any*
      file path ending in `src/payments/create-order.ts` with a `createOrder`
      symbol. It was consulted by both `evidence-gathering.ts` and
      `trace-symbol.ts`, and `finding-builder.ts` separately substituted a
      hardcoded protected-property statement for the same path. A real project
      with that (ordinary) path and symbol name would have been shown a
      confirmed incident that never happened in it — and because the items were
      `strong`, that fabricated history satisfied the block rule's
      `hasStrongEvidence` condition on its own. `packages/test-fixtures/src/evidence-fixtures.ts`
      deleted. The demo is unaffected (verified: risk still 96, confidence 100,
      still blocks) because its fixture repository declares the same issue and
      PR legitimately, in its committed contract and commit message. Locked by
      `evidence-gathering.test.ts` → "claims no evidence for a matching path
      when the repository has no history for it".
- [x] **`required_tests` made load-bearing.** Every block message told the
      developer to "add a regression test proving an equivalent mechanism", but
      the block rule's `hasEquivalentRegressionTest` input is
      `evidence.some(type === "test")` and nothing in the deterministic pipeline
      ever produced a `test` item — so following the instruction changed
      nothing. `requiredTestEvidence` now emits `medium` `test` evidence for
      contract-declared paths that exist on disk, which downgrades a block to a
      warning. Existence only: WhyGuard does not run, parse, or measure coverage
      of the test, and says so everywhere it matters.
- [x] **Free-tier host protection.** A repository size ceiling checked *before*
      cloning (`WHYGUARD_MAX_REPO_SIZE_MB`, default ~2 GB, using the repo size
      GitHub already returns with `pulls.get`), which publishes a neutral Check
      Run explaining the skip and records `status: "failed"` rather than a
      clean-looking pass; plus `sweepStaleWorkspaces` at API startup for clones
      orphaned by a process that died mid-scan, which `finally` cannot cover.
      A blobless partial clone was implemented, measured, and **reverted**: on
      `sindresorhus/got` it saved 2.4 MB and made the path-scoped pickaxe
      0.07s → 186.58s. Measurement table recorded in `cloneRepository`.
- [x] **`whyguard demo`, with two scenarios.** The zero-configuration entry
      point: builds a repository whose history genuinely contains the decision,
      scans it, and arms the Git hook so the reader's own next commit is
      aborted. `--scenario timeouts` exists to show the *boundary* — the same
      diff warns (HIGH, risk 70) until a decision is written down and then
      blocks (CRITICAL, risk 94.5). A single always-blocks demo teaches the
      wrong lesson. Both verified end-to-end from a packed npm tarball, not just
      from source.
- [x] README, architecture diagram, and a conventions guide. `README.md` and
      `README.es.md` lead with runnable commands and verified output rather than
      description. `docs/architecture/architecture.md` documents the decision
      pipeline, the per-surface data flows, the clone strategy with its
      measurements, and maps each section 8.4 trust boundary to enforcing code —
      including two new ones (the read API failing closed to loopback, and
      "WhyGuard never invents evidence"). New
      `docs/guides/feeding-whyguard.md` is the answer to "what does this tool
      need from me": every input it reads, the commit-message keywords that
      raise evidence strength, field-by-field contract semantics, the risk
      formula, and the anti-patterns.
- [ ] Rehearsed demo and backup video. A concrete, command-by-command runbook
      exists at `docs/demo/demo-script.md` (transcribes section 31's 10 steps
      into real commands for this repo) — rehearsing it out loud and recording
      the backup video is a human task and remains outstanding.
- Exit criterion (not yet met): the main scenario succeeds repeatedly in a clean
  environment — pending the actual rehearsal/recording and, later, the
  deployment step above.

### Notes

`apps/api` makes outbound network calls to GitHub (and, optionally, to AWS Bedrock) and
requires real secrets (`GITHUB_APP_ID`, `GITHUB_PRIVATE_KEY_BASE64`,
`GITHUB_WEBHOOK_SECRET` in `.env`, never committed). The Bedrock call is opt-in via
`WHYGUARD_LLM_ENABLED=true` plus `AWS_REGION`/`BEDROCK_MODEL_ID`; every other app/package,
and `apps/api`/`apps/cli` themselves when that flag is unset, remain fully local and
deterministic.

Implemented packages: `apps/cli`, `apps/mcp-server`, `apps/api`, `apps/dashboard`,
`packages/application`, `packages/git-adapter`, `packages/github-adapter`,
`packages/ast-adapter`, `packages/domain`, `packages/contracts`,
`packages/test-fixtures`, `packages/persistence-adapter`, `packages/llm-adapter`.

Not yet implemented (Phase 5/6 scope): `apps/worker`, `apps/dashboard`,
`packages/llm-adapter`, `packages/observability`.

`apps/api` exposes three read-only dashboard endpoints (`GET /reports`,
`GET /reports/:id`, `GET /decisions/:id`) via `reports-routes.ts`, only
registered when a database is configured. `scanPullRequest` and `whyguard scan`
both now also cache every active rationale contract they see into the
`decisions` table (`upsertDecision`), so `GET /decisions/:id` resolves to real
data instead of an always-empty table.

`packages/persistence-adapter` uses Node's built-in `node:sqlite` instead of the
originally planned `better-sqlite3`: this dev machine has no Visual Studio Build
Tools/C++ toolchain, and `better-sqlite3` had no prebuilt binary for the installed
Node version, so its native build failed. `node:sqlite` ships with Node itself, so
no native compilation is needed. It is still an experimental Node API; revisit via
an ADR if that becomes a real problem. This also required bumping the whole
monorepo from Node 20 (end-of-life 2026-04-30) to Node 24 LTS and Vitest from
2.1.8 to 3.2.7 (2.1.8 could not resolve `node:sqlite` at all — a known upstream
bug, fixed by the Vitest 3 upgrade).
