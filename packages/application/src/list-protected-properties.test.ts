import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Finding } from "@whyguard/contracts";
import { recordFinding, resetFindingStoreForTests } from "./finding-store.js";
import { listProtectedProperties } from "./list-protected-properties.js";

const testRoot = join(process.cwd(), ".tmp", "list-protected-properties-test");

const VALID_DECISION = `id: payment-idempotency
version: 1
status: active
scope:
  files:
    - src/payments/create-order.ts
  symbols:
    - createOrder
reason: >
  Prevent duplicate orders on retry.
must_preserve:
  - One idempotency key creates at most one order.
evidence:
  - type: issue
    id: "481"
owners:
  - payments-team
`;

function writeDecision(fileName: string, content: string): void {
  mkdirSync(join(testRoot, ".whyguard", "decisions"), { recursive: true });
  writeFileSync(join(testRoot, ".whyguard", "decisions", fileName), content, "utf-8");
}

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: "fnd_001",
    runId: "run_001",
    change: {
      id: "chg_001",
      filePath: "src/payments/refund.ts",
      symbol: "refundOrder",
      kind: "validation_removed",
      lines: { start: 1, end: 5 },
    },
    evidenceIds: [],
    evidence: [],
    protectedProperties: [
      {
        id: "pp_scan_001",
        statement: "Refund amount never exceeds the original charge.",
        category: "correctness",
        status: "proposed",
      },
    ],
    riskScore: 40,
    confidenceScore: 40,
    severity: "medium",
    reasonStatus: "unknown",
    explanation: "test",
    recommendation: "test",
    ...overrides,
  };
}

describe("listProtectedProperties", () => {
  beforeEach(() => {
    mkdirSync(testRoot, { recursive: true });
    resetFindingStoreForTests();
  });

  afterEach(() => {
    rmSync(testRoot, { recursive: true, force: true });
  });

  it("returns an empty array when nothing matches", () => {
    const result = listProtectedProperties({ repoRoot: testRoot, filePath: "src/unrelated.ts" });
    expect(result).toEqual([]);
  });

  it("returns confirmed properties from a matching active rationale contract", () => {
    writeDecision("payment-idempotency.yml", VALID_DECISION);
    const result = listProtectedProperties({
      repoRoot: testRoot,
      filePath: "src/payments/create-order.ts",
      symbol: "createOrder",
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.status).toBe("confirmed");
    expect(result[0]?.statement).toContain("idempotency key");
  });

  it("returns proposed properties from a recorded finding on the same file", () => {
    recordFinding(makeFinding());
    const result = listProtectedProperties({
      repoRoot: testRoot,
      filePath: "src/payments/refund.ts",
      symbol: "refundOrder",
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.status).toBe("proposed");
  });

  it("does not return a finding's properties when the symbol does not match", () => {
    recordFinding(makeFinding());
    const result = listProtectedProperties({
      repoRoot: testRoot,
      filePath: "src/payments/refund.ts",
      symbol: "cancelOrder",
    });
    expect(result).toEqual([]);
  });

  it("de-duplicates properties present in both a contract and a finding", () => {
    writeDecision("payment-idempotency.yml", VALID_DECISION);
    recordFinding(
      makeFinding({
        id: "fnd_002",
        change: {
          id: "chg_002",
          filePath: "src/payments/create-order.ts",
          symbol: "createOrder",
          kind: "condition_removed",
          lines: { start: 1, end: 5 },
        },
        protectedProperties: [
          {
            id: "pp_decision_payment-idempotency_0",
            statement: "dup",
            category: "business_rule",
            status: "confirmed",
          },
        ],
      }),
    );
    const result = listProtectedProperties({
      repoRoot: testRoot,
      filePath: "src/payments/create-order.ts",
      symbol: "createOrder",
    });
    expect(result).toHaveLength(1);
  });
});
