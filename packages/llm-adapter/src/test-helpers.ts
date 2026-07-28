import type { Finding } from "@whyguard/contracts";

/** Builds a minimal, schema-valid Finding for tests. Every field can be overridden. */
export function buildTestFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: "fnd_001",
    runId: "run_001",
    change: {
      id: "chg_001",
      filePath: "src/payments/create-order.ts",
      symbol: "createOrder",
      kind: "condition_removed",
      lines: { start: 10, end: 20 },
    },
    evidenceIds: ["ev_issue_481"],
    evidence: [
      { id: "ev_issue_481", type: "issue", title: "Duplicate orders on retry", strength: "strong" },
    ],
    protectedProperties: [
      {
        id: "pp_decision_payment-idempotency_0",
        statement: "One idempotency key creates at most one order.",
        category: "business_rule",
        status: "confirmed",
      },
    ],
    riskScore: 91,
    confidenceScore: 88,
    severity: "critical",
    reasonStatus: "known",
    explanation: "test explanation",
    recommendation: "test recommendation",
    ...overrides,
  };
}
