import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildPaymentFixture } from "@whyguard/test-fixtures";
import { traceSymbol } from "./trace-symbol.js";

/**
 * Integration test for `whyguard trace` and the `trace-historical-decision` skill.
 */
describe("traceSymbol", () => {
  const fixtureDir = join(process.cwd(), ".tmp", "whyguard-trace-test");

  afterAll(() => {
    rmSync(fixtureDir, { recursive: true, force: true });
  });

  it("reports a known reason via the confirmed rationale contract and history", () => {
    const { repoRoot } = buildPaymentFixture(fixtureDir);

    const result = traceSymbol({
      repoRoot,
      filePath: "src/payments/create-order.ts",
      symbol: "createOrder",
    });

    expect(result.reasonStatus).toBe("known");
    expect(result.matchingDecisionId).toBe("payment-idempotency");
    expect(result.protectedProperties.length).toBeGreaterThan(0);
    expect(result.protectedProperties.every((property) => property.status === "confirmed")).toBe(
      true,
    );
    // The fixture makes two commits touching this file.
    expect(result.history.length).toBeGreaterThanOrEqual(2);
    expect(result.history[0]?.subject).toContain("Simplify createOrder");
  });

  it("reports unknown for a file with no history, decision, or evidence", () => {
    const { repoRoot } = buildPaymentFixture(join(fixtureDir, "no-match"));

    const result = traceSymbol({
      repoRoot,
      filePath: "src/payments/refund.ts", // never existed in this fixture repo
      symbol: "refundOrder",
    });

    expect(result.reasonStatus).toBe("unknown");
    expect(result.matchingDecisionId).toBeUndefined();
    expect(result.protectedProperties).toEqual([]);
    expect(result.history).toEqual([]);
  });
});
