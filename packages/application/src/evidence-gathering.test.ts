import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  buildInventoryFixture,
  buildPaymentFixture,
  SAFE_CREATE_ORDER,
  SAFE_SYNC_INVENTORY,
  UNSAFE_CREATE_ORDER,
  UNSAFE_SYNC_INVENTORY,
  writeInventoryDecision,
} from "@whyguard/test-fixtures";
import { guardChange } from "./guard-change.js";
import {
  loadActiveContracts,
  loadActiveContractsWithDiagnostics,
  requiredTestEvidence,
} from "./evidence-gathering.js";

/**
 * Regression tests for two properties that are easy to break and expensive to get
 * wrong: WhyGuard must never claim evidence it cannot point at inside the repository,
 * and a contract's declared regression tests must actually affect the outcome.
 */
describe("evidence gathering", () => {
  const fixtureDir = join(process.cwd(), ".tmp", "whyguard-evidence-test");

  afterAll(() => {
    rmSync(fixtureDir, { recursive: true, force: true });
  });

  describe("no fabricated evidence", () => {
    /**
     * Locks the removal of `lookupEvidenceFixture`, which returned two hardcoded
     * `strong` evidence items (Issue #481, PR #493, pointing at
     * `github.com/demo-org/whyguard-demo`) for *any* file whose path ended in
     * `src/payments/create-order.ts` with a `createOrder` symbol. That path and symbol
     * name are ordinary enough to appear in real projects, so an unrelated repository
     * would have been shown a confirmed incident that never happened in it — and,
     * because the items were `strong`, that fabricated history was enough to satisfy
     * the block rule's `hasStrongEvidence` condition on its own.
     */
    it("claims no evidence for a matching path when the repository has no history for it", () => {
      const repoRoot = join(fixtureDir, "no-history");
      mkdirSync(join(repoRoot, "src", "payments"), { recursive: true });
      writeFileSync(join(repoRoot, "src", "payments", "create-order.ts"), SAFE_CREATE_ORDER);

      // Not a Git repository and no `.whyguard/decisions/`: there is nothing to know.
      const result = guardChange({
        repoRoot,
        filePath: "src/payments/create-order.ts",
        beforeContent: SAFE_CREATE_ORDER,
        afterContent: UNSAFE_CREATE_ORDER,
      });

      // The change itself is still detected — that part is pure AST comparison.
      expect(result.findings).toHaveLength(1);
      const finding = result.findings[0]?.finding;
      expect(finding?.change.kind).toBe("condition_removed");

      // But nothing is known about *why*, so nothing may be asserted.
      expect(finding?.evidence).toEqual([]);
      expect(finding?.reasonStatus).toBe("unknown");
      expect(finding?.protectedProperties).toEqual([]);
      expect(result.decision).not.toBe("block");

      // Specifically: none of the old hardcoded ids may ever reappear.
      const ids = finding?.evidence.map((item) => item.id) ?? [];
      expect(ids).not.toContain("ev_issue_481");
      expect(ids).not.toContain("ev_pr_493");
    });
  });

  /**
   * The claim the `whyguard demo --scenario timeouts` walkthrough makes out loud: the
   * only difference between "warned" and "blocked" is whether a human recorded the
   * decision. Asserted here so the demo's narration cannot drift away from the code.
   */
  describe("a recorded decision is what turns a warning into a block", () => {
    it("warns on the same change before the contract exists and blocks after", () => {
      const { repoRoot } = buildInventoryFixture(join(fixtureDir, "warn-then-block"));

      const before = guardChange({
        repoRoot,
        filePath: "src/logistics/sync-inventory.ts",
        beforeContent: SAFE_SYNC_INVENTORY,
        afterContent: UNSAFE_SYNC_INVENTORY,
      });
      expect(before.decision).toBe("warn");
      expect(before.findings.length).toBeGreaterThan(0);
      // Git history alone never reaches `strong`, which is exactly why it cannot block.
      expect(
        before.findings.every((r) => r.finding.evidence.every((e) => e.strength !== "strong")),
      ).toBe(true);

      writeInventoryDecision(repoRoot);

      const after = guardChange({
        repoRoot,
        filePath: "src/logistics/sync-inventory.ts",
        beforeContent: SAFE_SYNC_INVENTORY,
        afterContent: UNSAFE_SYNC_INVENTORY,
      });
      expect(after.decision).toBe("block");
      expect(
        after.findings.some((r) => r.finding.protectedProperties[0]?.status === "confirmed"),
      ).toBe(true);
    });
  });

  /**
   * A contract is the only input that can turn a warning into a block, so a decision
   * file that fails to load must never be silent. Found the hard way while writing a
   * contract for a real repository: `- A data: URL larger than the cap is rejected` makes
   * YAML parse the list item as a map, the schema rejects it, and the repository loses
   * all enforcement with no output whatsoever.
   */
  describe("invalid decision files are reported, not swallowed", () => {
    it("reports the file and reason while still loading the valid ones", () => {
      const { repoRoot } = buildPaymentFixture(join(fixtureDir, "invalid-contract"));
      writeFileSync(
        join(repoRoot, ".whyguard", "decisions", "broken.yml"),
        [
          "id: broken",
          "version: 1",
          "status: active",
          "scope:",
          "  files:",
          "    - src/payments/create-order.ts",
          "reason: Something",
          "must_preserve:",
          // The unquoted colon turns this item into a map instead of a string.
          "  - A data: URL larger than the cap is rejected",
        ].join("\n"),
      );

      const { contracts, invalid } = loadActiveContractsWithDiagnostics(repoRoot);

      expect(invalid).toHaveLength(1);
      expect(invalid[0]?.file).toContain("broken.yml");
      // The message must name the offending field. A raw ZodError message is a JSON
      // dump whose first line is just "[", which tells the reader nothing.
      expect(invalid[0]?.error).toContain("must_preserve");
      expect(invalid[0]?.error).not.toBe("[");
      // The fixture's own valid contract must still be usable.
      expect(contracts.map((contract) => contract.id)).toContain("payment-idempotency");
    });

    it("reports nothing when every decision file is valid", () => {
      const { repoRoot } = buildPaymentFixture(join(fixtureDir, "valid-contracts"));
      expect(loadActiveContractsWithDiagnostics(repoRoot).invalid).toEqual([]);
    });
  });

  describe("requiredTestEvidence", () => {
    it("ignores declared regression tests that do not exist on disk", () => {
      const { repoRoot } = buildPaymentFixture(join(fixtureDir, "missing-test"));
      const [contract] = loadActiveContracts(repoRoot);
      if (!contract) throw new Error("expected the fixture's active contract");

      // The fixture's contract declares `tests/payments/idempotency.test.ts`, which it
      // deliberately does not create.
      expect(contract.required_tests).toContain("tests/payments/idempotency.test.ts");
      expect(requiredTestEvidence(repoRoot, contract)).toEqual([]);
    });

    it("emits test evidence for a declared regression test that exists", () => {
      const { repoRoot } = buildPaymentFixture(join(fixtureDir, "present-test"));
      const [contract] = loadActiveContracts(repoRoot);
      if (!contract) throw new Error("expected the fixture's active contract");

      mkdirSync(join(repoRoot, "tests", "payments"), { recursive: true });
      writeFileSync(join(repoRoot, "tests", "payments", "idempotency.test.ts"), "// placeholder\n");

      const evidence = requiredTestEvidence(repoRoot, contract);
      expect(evidence).toHaveLength(1);
      expect(evidence[0]?.type).toBe("test");
      // `medium`, not `strong`: existence is not proof, so the finding must stay
      // visible rather than disappear.
      expect(evidence[0]?.strength).toBe("medium");
    });

    /**
     * The behavior every block message promises ("add a regression test proving an
     * equivalent mechanism, then commit again") and which did nothing before
     * `requiredTestEvidence` existed: `required_tests` was parsed and displayed but
     * never read by the block rule, whose `hasEquivalentRegressionTest` input is
     * `evidence.some(type === "test")` — an evidence type the deterministic pipeline
     * never produced.
     */
    it("downgrades a block to a warning once the declared regression test exists", () => {
      const { repoRoot } = buildPaymentFixture(join(fixtureDir, "escape-route"));

      const blocked = guardChange({
        repoRoot,
        filePath: "src/payments/create-order.ts",
        beforeContent: SAFE_CREATE_ORDER,
        afterContent: UNSAFE_CREATE_ORDER,
      });
      expect(blocked.decision).toBe("block");

      mkdirSync(join(repoRoot, "tests", "payments"), { recursive: true });
      writeFileSync(join(repoRoot, "tests", "payments", "idempotency.test.ts"), "// placeholder\n");

      const afterTest = guardChange({
        repoRoot,
        filePath: "src/payments/create-order.ts",
        beforeContent: SAFE_CREATE_ORDER,
        afterContent: UNSAFE_CREATE_ORDER,
      });
      expect(afterTest.decision).toBe("warn");
      expect(afterTest.findings[0]?.finding.evidence.some((item) => item.type === "test")).toBe(
        true,
      );
    });
  });
});
