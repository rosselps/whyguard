import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findMatchingContract, loadRationaleContracts } from "./rationale-contracts.js";
import type { RationaleContract } from "@whyguard/contracts";

const testRoot = join(process.cwd(), ".tmp", "rationale-contracts-test");

function writeDecision(fileName: string, content: string): void {
  mkdirSync(join(testRoot, ".whyguard", "decisions"), { recursive: true });
  writeFileSync(join(testRoot, ".whyguard", "decisions", fileName), content, "utf-8");
}

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

describe("loadRationaleContracts", () => {
  beforeEach(() => {
    rmSync(testRoot, { recursive: true, force: true });
  });

  afterEach(() => {
    rmSync(testRoot, { recursive: true, force: true });
  });

  it("returns an empty result when .whyguard/decisions does not exist", () => {
    mkdirSync(testRoot, { recursive: true });
    const result = loadRationaleContracts(testRoot);
    expect(result.contracts).toEqual([]);
    expect(result.invalid).toEqual([]);
  });

  it("loads and validates a well-formed decision file", () => {
    writeDecision("payment-idempotency.yml", VALID_DECISION);
    const result = loadRationaleContracts(testRoot);
    expect(result.invalid).toEqual([]);
    expect(result.contracts).toHaveLength(1);
    expect(result.contracts[0]?.id).toBe("payment-idempotency");
    expect(result.contracts[0]?.status).toBe("active");
  });

  it("collects invalid decision files separately instead of throwing", () => {
    writeDecision("broken.yml", "id: broken\nstatus: active\n"); // missing required fields
    const result = loadRationaleContracts(testRoot);
    expect(result.contracts).toEqual([]);
    expect(result.invalid).toHaveLength(1);
    expect(result.invalid[0]?.file).toContain("broken.yml");
  });

  it("ignores non-yaml files in the decisions directory", () => {
    writeDecision("payment-idempotency.yml", VALID_DECISION);
    writeFileSync(join(testRoot, ".whyguard", "decisions", "README.md"), "# notes", "utf-8");
    const result = loadRationaleContracts(testRoot);
    expect(result.contracts).toHaveLength(1);
  });
});

describe("findMatchingContract", () => {
  const contract: RationaleContract = {
    id: "payment-idempotency",
    version: 1,
    status: "active",
    scope: { files: ["src/payments/create-order.ts"], symbols: ["createOrder"] },
    reason: "test",
    must_preserve: ["invariant"],
    evidence: [],
    required_tests: [],
    expires_when: [],
    owners: [],
  };

  it("matches by exact file path and symbol", () => {
    const match = findMatchingContract([contract], "src/payments/create-order.ts", "createOrder");
    expect(match?.id).toBe("payment-idempotency");
  });

  it("matches a suffix path (e.g. absolute path ending in the scoped relative path)", () => {
    const match = findMatchingContract(
      [contract],
      "C:\\repo\\src\\payments\\create-order.ts",
      "createOrder",
    );
    expect(match?.id).toBe("payment-idempotency");
  });

  it("does not match a different symbol in the same file", () => {
    const match = findMatchingContract([contract], "src/payments/create-order.ts", "cancelOrder");
    expect(match).toBeUndefined();
  });

  it("does not match a different file", () => {
    const match = findMatchingContract([contract], "src/payments/refund.ts", "createOrder");
    expect(match).toBeUndefined();
  });

  it("matches regardless of symbol when the contract declares no symbols", () => {
    const scopelessContract: RationaleContract = {
      ...contract,
      scope: { files: ["src/payments/create-order.ts"] },
    };
    const match = findMatchingContract(
      [scopelessContract],
      "src/payments/create-order.ts",
      undefined,
    );
    expect(match?.id).toBe("payment-idempotency");
  });
});
