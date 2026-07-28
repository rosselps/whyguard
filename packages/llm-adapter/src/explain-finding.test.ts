import { describe, expect, it } from "vitest";
import type { BedrockInvoker } from "./bedrock-invoker.js";
import { explainFinding } from "./explain-finding.js";
import { buildTestFinding } from "./test-helpers.js";

function validModelJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    summary: "The idempotency guard was removed.",
    protectedProperty: "One idempotency key creates at most one order.",
    recommendation: "Restore the guard or add an equivalent mechanism.",
    usedEvidenceIds: ["ev_issue_481"],
    uncertainty: "Strong evidence supports this.",
    ...overrides,
  });
}

describe("explainFinding", () => {
  it("returns the deterministic fallback when no invoker is provided", async () => {
    const explanation = await explainFinding(buildTestFinding());
    expect(explanation.source).toBe("fallback");
  });

  it("never calls the invoker when it is omitted, even if Bedrock env vars exist", async () => {
    // No invoker passed at all — this test exists to document the contract
    // explicitly, not just rely on the previous test's behavior.
    const explanation = await explainFinding(buildTestFinding(), {});
    expect(explanation.source).toBe("fallback");
  });

  it("returns a validated bedrock explanation when the invoker responds correctly", async () => {
    const invoker: BedrockInvoker = { invoke: () => Promise.resolve(validModelJson()) };
    const explanation = await explainFinding(buildTestFinding(), {
      invoker,
      now: () => "2026-01-01T00:00:00Z",
    });
    expect(explanation.source).toBe("bedrock");
    expect(explanation.generatedAt).toBe("2026-01-01T00:00:00Z");
    expect(explanation.summary).toBe("The idempotency guard was removed.");
  });

  it("extracts JSON even when the model wraps it in markdown fences", async () => {
    const invoker: BedrockInvoker = {
      invoke: () => Promise.resolve(`Here is the result:\n\`\`\`json\n${validModelJson()}\n\`\`\``),
    };
    const explanation = await explainFinding(buildTestFinding(), { invoker });
    expect(explanation.source).toBe("bedrock");
  });

  it("falls back when the invoker throws", async () => {
    const invoker: BedrockInvoker = {
      invoke: () => Promise.reject(new Error("network error")),
    };
    const explanation = await explainFinding(buildTestFinding(), { invoker });
    expect(explanation.source).toBe("fallback");
  });

  it("falls back when the model response is not valid JSON", async () => {
    const invoker: BedrockInvoker = { invoke: () => Promise.resolve("not json at all") };
    const explanation = await explainFinding(buildTestFinding(), { invoker });
    expect(explanation.source).toBe("fallback");
  });

  it("falls back when the JSON does not match the schema", async () => {
    const invoker: BedrockInvoker = {
      invoke: () => Promise.resolve(JSON.stringify({ summary: "only this" })),
    };
    const explanation = await explainFinding(buildTestFinding(), { invoker });
    expect(explanation.source).toBe("fallback");
  });

  it("falls back when the model cites an evidence ID not present on the finding", async () => {
    const invoker: BedrockInvoker = {
      invoke: () => Promise.resolve(validModelJson({ usedEvidenceIds: ["ev_fabricated_999"] })),
    };
    const explanation = await explainFinding(buildTestFinding(), { invoker });
    expect(explanation.source).toBe("fallback");
  });

  it("accepts a response citing a subset of known evidence IDs", async () => {
    const finding = buildTestFinding({
      evidence: [
        { id: "ev_a", type: "issue", title: "A", strength: "strong" },
        { id: "ev_b", type: "commit", title: "B", strength: "medium" },
      ],
    });
    const invoker: BedrockInvoker = {
      invoke: () => Promise.resolve(validModelJson({ usedEvidenceIds: ["ev_a"] })),
    };
    const explanation = await explainFinding(finding, { invoker });
    expect(explanation.source).toBe("bedrock");
  });
});
