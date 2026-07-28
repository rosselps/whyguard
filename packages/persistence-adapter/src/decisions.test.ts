import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, openDatabase, type WhyGuardDatabase } from "./database.js";
import { getDecision, listDecisions, upsertDecision } from "./decisions.js";
import { buildTestRationaleContract } from "./test-helpers.js";

describe("decisions", () => {
  let db: WhyGuardDatabase;

  beforeEach(() => {
    db = openDatabase(":memory:");
  });

  afterEach(() => {
    closeDatabase(db);
  });

  it("returns undefined for a decision that was never cached", () => {
    expect(getDecision(db, "unknown")).toBeUndefined();
  });

  it("upserts and retrieves a decision with nested fields intact", () => {
    upsertDecision(db, {
      contract: buildTestRationaleContract(),
      now: () => "2026-07-01T00:00:00Z",
    });

    const decision = getDecision(db, "payment-idempotency");
    expect(decision).toMatchObject({
      id: "payment-idempotency",
      version: 1,
      status: "active",
      owners: ["payments-team"],
      mustPreserve: ["One idempotency key creates at most one order."],
    });
    expect(decision?.scope.files).toEqual(["src/payments/create-order.ts"]);
    expect(decision?.evidence).toEqual([{ type: "issue", id: "481" }]);
  });

  it("replaces an existing decision on conflict rather than duplicating it", () => {
    upsertDecision(db, { contract: buildTestRationaleContract({ version: 1 }) });
    upsertDecision(db, {
      contract: buildTestRationaleContract({ version: 2, status: "replaced" }),
    });

    expect(listDecisions(db)).toHaveLength(1);
    const decision = getDecision(db, "payment-idempotency");
    expect(decision?.version).toBe(2);
    expect(decision?.status).toBe("replaced");
  });

  it("lists multiple decisions ordered by most recently updated", () => {
    upsertDecision(db, {
      contract: buildTestRationaleContract({ id: "decision-a" }),
      now: () => "2026-01-01T00:00:00Z",
    });
    upsertDecision(db, {
      contract: buildTestRationaleContract({ id: "decision-b" }),
      now: () => "2026-06-01T00:00:00Z",
    });

    const decisions = listDecisions(db);
    expect(decisions.map((d) => d.id)).toEqual(["decision-b", "decision-a"]);
  });

  it("stores the source path when provided", () => {
    upsertDecision(db, {
      contract: buildTestRationaleContract(),
      sourcePath: ".whyguard/decisions/payment-idempotency.yml",
    });
    expect(getDecision(db, "payment-idempotency")?.sourcePath).toBe(
      ".whyguard/decisions/payment-idempotency.yml",
    );
  });
});
