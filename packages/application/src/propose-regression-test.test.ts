import { beforeEach, describe, expect, it } from "vitest";
import type { Finding } from "@whyguard/contracts";
import { recordFinding, resetFindingStoreForTests } from "./finding-store.js";
import { FindingNotFoundError, proposeRegressionTest } from "./propose-regression-test.js";

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
    evidenceIds: ["ev_issue_481"],
    evidence: [
      { id: "ev_issue_481", type: "issue", title: "Duplicate orders on retry", strength: "strong" },
    ],
    protectedProperties: [
      {
        id: "pp_001",
        statement: "One idempotency key creates at most one order.",
        category: "business_rule",
        status: "proposed",
      },
    ],
    riskScore: 91,
    confidenceScore: 88,
    severity: "critical",
    reasonStatus: "known",
    explanation: "test",
    recommendation: "test",
    ...overrides,
  };
}

describe("proposeRegressionTest", () => {
  beforeEach(() => {
    resetFindingStoreForTests();
  });

  it("throws FindingNotFoundError for an unrecorded finding id", () => {
    expect(() => proposeRegressionTest({ findingId: "unknown" })).toThrow(FindingNotFoundError);
  });

  it("builds a vitest skeleton naming the protected property and evidence", () => {
    recordFinding(makeFinding());
    const proposal = proposeRegressionTest({ findingId: "fnd_001" });

    expect(proposal.framework).toBe("vitest");
    expect(proposal.filePath).toBe("src/payments/create-order.regression.test.ts");
    expect(proposal.code).toContain("createOrder");
    expect(proposal.code).toContain("One idempotency key creates at most one order.");
    expect(proposal.code).toContain("ev_issue_481");
    expect(proposal.code).toContain("it.todo");
    expect(proposal.code).not.toContain('it("preserves');
  });

  it("defaults to a vitest-shaped skeleton for the jest framework alias", () => {
    recordFinding(makeFinding());
    const proposal = proposeRegressionTest({ findingId: "fnd_001", framework: "jest" });
    expect(proposal.framework).toBe("jest");
    expect(proposal.code).toContain("it.todo");
  });

  it("falls back to a generic statement when no protected property is set", () => {
    recordFinding(makeFinding({ id: "fnd_002", protectedProperties: [] }));
    const proposal = proposeRegressionTest({ findingId: "fnd_002" });
    expect(proposal.code).toContain("no protected property was confirmed yet");
  });
});
