import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  buildPaymentFixture,
  SAFE_CREATE_ORDER,
  UNSAFE_CREATE_ORDER,
} from "@whyguard/test-fixtures";
import { scanDiff, resetScanDiffCountersForTests } from "./scan-diff.js";
import { resetFindingCounterForTests } from "./finding-builder.js";
import { guardChange, resetGuardChangeCountersForTests } from "./guard-change.js";
import { traceSymbol } from "./trace-symbol.js";
import { buildRegressionTestProposal } from "./propose-regression-test.js";

/**
 * End-to-end test of the demo walkthrough.
 *
 * Composes the same deterministic use cases the CLI, MCP server, and `apps/api` call
 * individually, in the order a human exercises them during the demo — proving the chain
 * works together, not just each piece in isolation. No network and no LLM
 * (`WHYGUARD_LLM_ENABLED` is irrelevant here: this package never imports
 * `llm-adapter`).
 *
 * The steps it covers, and the two it deliberately does not:
 *
 *   1. Open a PR that removes payment idempotency.
 *      -> represented by `scanDiff(base: safeSha, head: unsafeSha)`.
 *   2. Confirm WhyGuard detects it.
 *      -> asserted below (one critical `condition_removed` finding).
 *   3. Confirm lineage includes Issue #481 and PR #493.
 *      -> asserted below (`evidenceIds` contains both fixture evidence ids).
 *   4. Confirm GitHub Check requests action.
 *      -> NOT re-asserted here: `scanPullRequest`'s conclusion mapping
 *         (critical finding -> "action_required") is covered by
 *         `apps/api/src/webhook-handler.test.ts` and `server.test.ts`, which
 *         also cover webhook signature/dedup mechanics this test has no reason
 *         to duplicate.
 *   5. Confirm dashboard renders the graph.
 *      -> NOT testable here (a browser UI). `apps/dashboard` reads the exact
 *         `GET /reports/:id` shape this scan produces; that contract is covered
 *         by `apps/api`'s route tests, and rendering was verified manually per
 *         AGENTS.md's Phase 5 entry.
 *   6. Confirm Kiro hook blocks the same edit.
 *      -> asserted below via `guardChange` (the same use case
 *         `apps/cli`'s `whyguard guard`/`whyguard hook` commands call).
 *   7. Apply a safe replacement with a regression test.
 *      -> asserted below: a regression-test proposal is generated for the
 *         blocked finding, and a refactor that leaves the guard clause intact
 *         is allowed (no sensitive change detected at all).
 *   8. Confirm Check succeeds.
 *      -> asserted below via a second `scanDiff` against the safe head,
 *         which produces zero findings (the deterministic input to a
 *         "success" Check conclusion).
 */
describe("demo walkthrough (end-to-end)", () => {
  const fixtureDir = join(process.cwd(), ".tmp", "whyguard-demo-script-e2e");

  beforeEach(() => {
    resetScanDiffCountersForTests();
    resetFindingCounterForTests();
    resetGuardChangeCountersForTests();
  });

  afterAll(() => {
    rmSync(fixtureDir, { recursive: true, force: true });
  });

  it("runs the full detect -> block -> propose-test -> safe-refactor -> succeed flow", () => {
    const { repoRoot, safeSha, unsafeSha } = buildPaymentFixture(fixtureDir);

    // Step 1-3: scanning the "PR" (safe -> unsafe) detects the idempotency guard
    // removal with strong evidence tracing back to Issue #481 and PR #493.
    const unsafeReport = scanDiff({ repoRoot, base: safeSha, head: unsafeSha, source: "github" });
    expect(unsafeReport.findings).toHaveLength(1);
    const [finding] = unsafeReport.findings;
    expect(finding?.change.kind).toBe("condition_removed");
    expect(finding?.severity).toBe("critical");
    expect(finding?.reasonStatus).toBe("known");
    expect(finding?.evidenceIds).toContain("ev_decision_payment-idempotency_issue_481");
    expect(finding?.evidenceIds).toContain("ev_decision_payment-idempotency_pull_request_493");
    expect(finding?.protectedProperties[0]?.statement).toContain("idempotency key");
    if (!finding) throw new Error("expected a finding");

    // Step 6: the same edit, proposed through Kiro's PreToolUse guardrail (the
    // `whyguard guard`/`whyguard hook` CLI commands), must be blocked.
    const guardResult = guardChange({
      repoRoot,
      filePath: "src/payments/create-order.ts",
      beforeContent: SAFE_CREATE_ORDER,
      afterContent: UNSAFE_CREATE_ORDER,
    });
    expect(guardResult.decision).toBe("block");
    expect(guardResult.feedback).toContain("WHYGUARD BLOCKED THIS EDIT");
    expect(guardResult.feedback).toContain("idempotency key");

    // Step 7 (part 1): a human/agent asks for a regression-test proposal for the
    // blocked finding before attempting any replacement — never auto-executed,
    //; this only asserts the skeleton is produced.
    const proposal = buildRegressionTestProposal(finding);
    expect(proposal.framework).toBe("vitest");
    expect(proposal.code).toContain("createOrder");
    expect(proposal.code).toContain("it.todo");
    expect(proposal.code).toContain("idempotency key");

    // Step 7 (part 2): a "safe refactor" that leaves the protected guard clause
    // intact (only cosmetic changes elsewhere) must not be blocked at all —
    // preserving the property, not just avoiding the literal old code.
    const safeRefactor = SAFE_CREATE_ORDER.replace(
      "Historical context (Issue #481 / PR #493):",
      "Historical context (see Issue #481 / PR #493):",
    );
    expect(safeRefactor).not.toBe(SAFE_CREATE_ORDER);
    const safeGuardResult = guardChange({
      repoRoot,
      filePath: "src/payments/create-order.ts",
      beforeContent: SAFE_CREATE_ORDER,
      afterContent: safeRefactor,
    });
    expect(safeGuardResult.decision).toBe("allow");
    expect(safeGuardResult.findings).toHaveLength(0);

    // Step 8: scanning the resulting "PR" (safe -> still-safe) must produce zero
    // findings, the deterministic input to a successful GitHub Check conclusion.
    const successReport = scanDiff({ repoRoot, base: safeSha, head: safeSha, source: "github" });
    expect(successReport.findings).toHaveLength(0);

    // Bonus: before any of this, `whyguard trace` must
    // already report the confirmed decision and evidence for this symbol, so a
    // developer can check history before proposing a change at all.
    const trace = traceSymbol({
      repoRoot,
      filePath: "src/payments/create-order.ts",
      symbol: "createOrder",
    });
    expect(trace.reasonStatus).toBe("known");
    expect(trace.matchingDecisionId).toBe("payment-idempotency");
  });
});
