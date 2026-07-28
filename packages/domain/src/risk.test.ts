import { describe, expect, it } from "vitest";
import { computeConfidenceScore, computeRiskScore, decideBlock, deriveSeverity } from "./risk.js";
import type { Evidence } from "@whyguard/contracts";

describe("computeRiskScore", () => {
  it("weights every factor by the documented coefficient", () => {
    // All factors at 100 must yield the maximum score of 100.
    const maxScore = computeRiskScore({
      moduleCriticality: 100,
      historicalSeverity: 100,
      evidenceStrength: 100,
      missingRegressionTest: 100,
      semanticChangeMagnitude: 100,
      repeatedIncidentSignal: 100,
    });
    expect(maxScore).toBe(100);

    // All factors at 0 must yield 0.
    const minScore = computeRiskScore({
      moduleCriticality: 0,
      historicalSeverity: 0,
      evidenceStrength: 0,
      missingRegressionTest: 0,
      semanticChangeMagnitude: 0,
      repeatedIncidentSignal: 0,
    });
    expect(minScore).toBe(0);
  });

  it("applies the documented weight for moduleCriticality (0.25)", () => {
    const score = computeRiskScore({
      moduleCriticality: 100,
      historicalSeverity: 0,
      evidenceStrength: 0,
      missingRegressionTest: 0,
      semanticChangeMagnitude: 0,
      repeatedIncidentSignal: 0,
    });
    expect(score).toBe(25);
  });

  it("clamps out-of-range factors to 0..100", () => {
    const score = computeRiskScore({
      moduleCriticality: 500,
      historicalSeverity: -50,
      evidenceStrength: 0,
      missingRegressionTest: 0,
      semanticChangeMagnitude: 0,
      repeatedIncidentSignal: 0,
    });
    expect(score).toBe(25); // moduleCriticality clamped to 100 * 0.25
  });
});

describe("computeConfidenceScore", () => {
  it("returns low confidence when there is no evidence (unknown-reason behavior)", () => {
    expect(computeConfidenceScore([])).toBeLessThan(40);
  });

  it("returns high confidence for strong evidence", () => {
    const evidence: Evidence[] = [
      { id: "e1", type: "issue", title: "Issue", strength: "strong" },
      { id: "e2", type: "pull_request", title: "PR", strength: "strong" },
    ];
    expect(computeConfidenceScore(evidence)).toBeGreaterThanOrEqual(75);
  });

  it("returns lower confidence for weak evidence", () => {
    const evidence: Evidence[] = [{ id: "e1", type: "commit", title: "Commit", strength: "weak" }];
    expect(computeConfidenceScore(evidence)).toBeLessThan(50);
  });
});

describe("deriveSeverity", () => {
  it("maps risk score to severity buckets aligned with the block threshold", () => {
    expect(deriveSeverity(85)).toBe("critical");
    expect(deriveSeverity(65)).toBe("high");
    expect(deriveSeverity(40)).toBe("medium");
    expect(deriveSeverity(10)).toBe("low");
  });
});

describe("decideBlock", () => {
  it("blocks only when every condition of the block rule holds", () => {
    const decision = decideBlock({
      riskScore: 90,
      confidenceScore: 80,
      hasStrongEvidence: true,
      hasProtectedProperty: true,
      weakensProtectedProperty: true,
      hasEquivalentRegressionTest: false,
    });
    expect(decision).toBe("block");
  });

  it("does not block when a regression test already covers the property", () => {
    const decision = decideBlock({
      riskScore: 90,
      confidenceScore: 80,
      hasStrongEvidence: true,
      hasProtectedProperty: true,
      weakensProtectedProperty: true,
      hasEquivalentRegressionTest: true,
    });
    expect(decision).not.toBe("block");
  });

  it("does not block when confidence is below threshold", () => {
    const decision = decideBlock({
      riskScore: 90,
      confidenceScore: 50,
      hasStrongEvidence: true,
      hasProtectedProperty: true,
      weakensProtectedProperty: true,
      hasEquivalentRegressionTest: false,
    });
    expect(decision).not.toBe("block");
  });

  it("allows low-risk, low-confidence changes", () => {
    const decision = decideBlock({
      riskScore: 10,
      confidenceScore: 90,
      hasStrongEvidence: false,
      hasProtectedProperty: false,
      weakensProtectedProperty: false,
      hasEquivalentRegressionTest: false,
    });
    expect(decision).toBe("allow");
  });
});
