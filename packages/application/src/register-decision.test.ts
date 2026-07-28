import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ConfirmationRequiredError,
  DecisionAlreadyExistsError,
  registerDecision,
} from "./register-decision.js";

const testRoot = join(process.cwd(), ".tmp", "register-decision-test");

const VALID_CONTRACT = {
  id: "payment-idempotency",
  version: 1,
  status: "active",
  scope: { files: ["src/payments/create-order.ts"], symbols: ["createOrder"] },
  reason: "Prevent duplicate orders on retry.",
  must_preserve: ["One idempotency key creates at most one order."],
  evidence: [{ type: "issue", id: "481" }],
  owners: ["payments-team"],
};

describe("registerDecision", () => {
  beforeEach(() => {
    mkdirSync(testRoot, { recursive: true });
  });

  afterEach(() => {
    rmSync(testRoot, { recursive: true, force: true });
  });

  it("throws ConfirmationRequiredError when confirmed is not exactly true", () => {
    expect(() =>
      registerDecision({ repoRoot: testRoot, contract: VALID_CONTRACT, confirmed: false }),
    ).toThrow(ConfirmationRequiredError);
  });

  it("rejects a contract that fails schema validation, even if confirmed", () => {
    expect(() =>
      registerDecision({
        repoRoot: testRoot,
        contract: { id: "broken" },
        confirmed: true,
      }),
    ).toThrow();
  });

  it("writes a validated contract to .whyguard/decisions/<id>.yml", () => {
    const result = registerDecision({
      repoRoot: testRoot,
      contract: VALID_CONTRACT,
      confirmed: true,
    });

    expect(result.filePath).toBe(
      join(testRoot, ".whyguard", "decisions", "payment-idempotency.yml"),
    );
    const written = readFileSync(result.filePath, "utf-8");
    expect(written).toContain("payment-idempotency");
    expect(written).toContain("One idempotency key creates at most one order.");
  });

  it("refuses to overwrite an existing decision file by default", () => {
    registerDecision({ repoRoot: testRoot, contract: VALID_CONTRACT, confirmed: true });
    expect(() =>
      registerDecision({ repoRoot: testRoot, contract: VALID_CONTRACT, confirmed: true }),
    ).toThrow(DecisionAlreadyExistsError);
  });

  it("allows overwriting when allowOverwrite is explicitly true", () => {
    registerDecision({ repoRoot: testRoot, contract: VALID_CONTRACT, confirmed: true });
    const updated = { ...VALID_CONTRACT, version: 2 };
    const result = registerDecision({
      repoRoot: testRoot,
      contract: updated,
      confirmed: true,
      allowOverwrite: true,
    });
    expect(result.contract.version).toBe(2);
  });
});
