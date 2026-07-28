import { beforeEach, describe, expect, it } from "vitest";
import type { Finding } from "@whyguard/contracts";
import {
  getFinding,
  listFindings,
  recordFinding,
  recordFindings,
  resetFindingStoreForTests,
} from "./finding-store.js";

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: "fnd_001",
    runId: "run_001",
    change: {
      id: "chg_001",
      filePath: "src/payments/create-order.ts",
      symbol: "createOrder",
      kind: "condition_removed",
      lines: { start: 1, end: 5 },
    },
    evidenceIds: [],
    evidence: [],
    protectedProperties: [],
    riskScore: 10,
    confidenceScore: 10,
    severity: "low",
    reasonStatus: "unknown",
    explanation: "test",
    recommendation: "test",
    ...overrides,
  };
}

describe("finding-store", () => {
  beforeEach(() => {
    resetFindingStoreForTests();
  });

  it("returns undefined for an id that was never recorded", () => {
    expect(getFinding("does-not-exist")).toBeUndefined();
  });

  it("round-trips a single recorded finding", () => {
    const finding = makeFinding();
    recordFinding(finding);
    expect(getFinding("fnd_001")).toEqual(finding);
  });

  it("records multiple findings at once", () => {
    const a = makeFinding({ id: "fnd_001" });
    const b = makeFinding({ id: "fnd_002" });
    recordFindings([a, b]);
    expect(listFindings()).toHaveLength(2);
    expect(getFinding("fnd_002")).toEqual(b);
  });

  it("overwrites a finding recorded under the same id", () => {
    recordFinding(makeFinding({ id: "fnd_001", severity: "low" }));
    recordFinding(makeFinding({ id: "fnd_001", severity: "critical" }));
    expect(getFinding("fnd_001")?.severity).toBe("critical");
    expect(listFindings()).toHaveLength(1);
  });

  it("clears everything on reset", () => {
    recordFinding(makeFinding());
    resetFindingStoreForTests();
    expect(listFindings()).toEqual([]);
  });
});
