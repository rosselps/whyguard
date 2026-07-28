import { describe, expect, it } from "vitest";
import { buildFallbackExplanation } from "./fallback.js";
import { buildTestFinding } from "./test-helpers.js";

describe("buildFallbackExplanation", () => {
  it("marks the explanation as a fallback", () => {
    const explanation = buildFallbackExplanation(buildTestFinding(), () => "2026-01-01T00:00:00Z");
    expect(explanation.source).toBe("fallback");
    expect(explanation.generatedAt).toBe("2026-01-01T00:00:00Z");
  });

  it("uses the finding's own explanation/recommendation verbatim", () => {
    const finding = buildTestFinding({
      explanation: "custom explanation",
      recommendation: "custom rec",
    });
    const explanation = buildFallbackExplanation(finding);
    expect(explanation.summary).toBe("custom explanation");
    expect(explanation.recommendation).toBe("custom rec");
  });

  it("only cites evidence IDs actually present on the finding", () => {
    const finding = buildTestFinding({
      evidence: [
        { id: "ev_a", type: "issue", title: "A", strength: "strong" },
        { id: "ev_b", type: "commit", title: "B", strength: "medium" },
      ],
    });
    const explanation = buildFallbackExplanation(finding);
    expect(explanation.usedEvidenceIds).toEqual(["ev_a", "ev_b"]);
  });

  it("falls back to a placeholder evidence marker when there is no evidence", () => {
    const explanation = buildFallbackExplanation(buildTestFinding({ evidence: [] }));
    expect(explanation.usedEvidenceIds).toEqual(["none"]);
  });

  it("uses the first protected property's statement", () => {
    const explanation = buildFallbackExplanation(buildTestFinding());
    expect(explanation.protectedProperty).toBe("One idempotency key creates at most one order.");
  });

  it("states no property is confirmed when none exist", () => {
    const explanation = buildFallbackExplanation(buildTestFinding({ protectedProperties: [] }));
    expect(explanation.protectedProperty).toContain("No protected property");
  });

  it("flags unknown reasonStatus explicitly in uncertainty", () => {
    const explanation = buildFallbackExplanation(buildTestFinding({ reasonStatus: "unknown" }));
    expect(explanation.uncertainty).toContain("No reliable historical reason");
  });
});
