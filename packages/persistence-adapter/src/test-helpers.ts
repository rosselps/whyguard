import type { Finding, LlmExplanation, RationaleContract, ScanReport } from "@whyguard/contracts";

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

/** Builds a minimal, schema-valid ScanReport for tests. */
export function buildTestScanReport(overrides: Partial<ScanReport> = {}): ScanReport {
  return {
    schemaVersion: 1,
    run: {
      id: "run_001",
      repository: { provider: "github", owner: "acme", name: "widgets" },
      baseSha: "aaaaaaaaaaaa",
      headSha: "bbbbbbbbbbbb",
      source: "github",
      status: "completed",
      createdAt: "2026-07-01T00:00:00.000Z",
    },
    findings: [buildTestFinding()],
    llmEnabled: false,
    ...overrides,
  };
}

/** Builds a minimal, schema-valid LlmExplanation for tests. */
export function buildTestLlmExplanation(overrides: Partial<LlmExplanation> = {}): LlmExplanation {
  return {
    summary: "test summary",
    protectedProperty: "One idempotency key creates at most one order.",
    recommendation: "test recommendation",
    usedEvidenceIds: ["ev_issue_481"],
    uncertainty: "test uncertainty",
    source: "fallback",
    generatedAt: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

/** Builds a minimal, schema-valid RationaleContract for tests. */
export function buildTestRationaleContract(
  overrides: Partial<RationaleContract> = {},
): RationaleContract {
  return {
    id: "payment-idempotency",
    version: 1,
    status: "active",
    scope: { files: ["src/payments/create-order.ts"], symbols: ["createOrder"] },
    reason: "Prevent duplicate orders on retry.",
    must_preserve: ["One idempotency key creates at most one order."],
    evidence: [{ type: "issue", id: "481" }],
    required_tests: [],
    expires_when: [],
    owners: ["payments-team"],
    ...overrides,
  };
}
