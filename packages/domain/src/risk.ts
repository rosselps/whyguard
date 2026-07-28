import type { Evidence, Severity } from "@whyguard/contracts";

/**
 * Deterministic risk score.
 *
 * risk =
 *   0.25 * moduleCriticality +
 *   0.20 * historicalSeverity +
 *   0.20 * evidenceStrength +
 *   0.15 * missingRegressionTest +
 *   0.10 * semanticChangeMagnitude +
 *   0.10 * repeatedIncidentSignal
 *
 * Every factor must already be normalized to the 0..100 range by the caller.
 */
export type RiskFactors = {
  moduleCriticality: number;
  historicalSeverity: number;
  evidenceStrength: number;
  missingRegressionTest: number;
  semanticChangeMagnitude: number;
  repeatedIncidentSignal: number;
};

const RISK_WEIGHTS: Record<keyof RiskFactors, number> = {
  moduleCriticality: 0.25,
  historicalSeverity: 0.2,
  evidenceStrength: 0.2,
  missingRegressionTest: 0.15,
  semanticChangeMagnitude: 0.1,
  repeatedIncidentSignal: 0.1,
};

function clamp(value: number, min = 0, max = 100): number {
  return Math.min(max, Math.max(min, value));
}

export function computeRiskScore(factors: RiskFactors): number {
  let score = 0;
  for (const key of Object.keys(RISK_WEIGHTS) as (keyof RiskFactors)[]) {
    score += RISK_WEIGHTS[key] * clamp(factors[key]);
  }
  return Math.round(clamp(score) * 100) / 100;
}

/**
 * Confidence score derived from evidence strength.
 *
 * The context document defines the evidence-strength rubric and the
 * block-rule thresholds but does not fix an exact confidence formula.
 * This is a deterministic, explainable interpretation: confidence tracks the
 * **strongest** evidence available, with a small bonus when more than one substantive
 * item corroborates it. Zero evidence yields low confidence and an "unknown" reason.
 *
 * Why the strongest item and not the average: averaging meant additional evidence
 * could *lower* confidence. On a real repository, a finding backed by a
 * human-confirmed rationale contract (`strong`) plus one incidental commit (`weak`)
 * scored 60 — below the 75 block threshold — while the contract alone would have
 * scored 95. WhyGuard became less sure of something a human had already confirmed
 * simply because it found more context. Corroboration must never subtract.
 *
 * A weak item still cannot *create* confidence on its own: with only weak evidence the
 * strongest weight is low, which is what keeps a temporal correlation from reading as
 * a confirmed reason.
 */
const EVIDENCE_STRENGTH_WEIGHT: Record<Evidence["strength"], number> = {
  strong: 95,
  medium: 60,
  weak: 25,
};

export function computeConfidenceScore(evidence: Evidence[]): number {
  if (evidence.length === 0) return 15;

  const strongest = Math.max(...evidence.map((item) => EVIDENCE_STRENGTH_WEIGHT[item.strength]));
  // Only substantive items corroborate; piling up weak signals must not add up to
  // certainty.
  const corroborating = evidence.filter((item) => item.strength !== "weak").length - 1;
  const corroborationBonus = Math.min(5 * Math.max(0, corroborating), 10);

  return Math.round(clamp(strongest + corroborationBonus) * 100) / 100;
}

/**
 * Severity bucketing from the risk score. The document specifies the block threshold
 * (riskScore >= 80) but not explicit severity bucket boundaries; this mapping keeps
 * "critical" aligned with the block threshold and spreads the remaining range evenly.
 */
export function deriveSeverity(riskScore: number): Severity {
  if (riskScore >= 80) return "critical";
  if (riskScore >= 60) return "high";
  if (riskScore >= 35) return "medium";
  return "low";
}

export type BlockDecisionInput = {
  riskScore: number;
  confidenceScore: number;
  hasStrongEvidence: boolean;
  hasProtectedProperty: boolean;
  weakensProtectedProperty: boolean;
  hasEquivalentRegressionTest: boolean;
  blockRiskThreshold?: number;
  blockConfidenceThreshold?: number;
};

export type BlockDecision = "allow" | "warn" | "block";

/**
 * Kiro PreToolUse block rule.
 * Blocks only when every condition holds; otherwise warns if risk is elevated, else allows.
 */
export function decideBlock(input: BlockDecisionInput): BlockDecision {
  const riskThreshold = input.blockRiskThreshold ?? 80;
  const confidenceThreshold = input.blockConfidenceThreshold ?? 75;

  const shouldBlock =
    input.riskScore >= riskThreshold &&
    input.confidenceScore >= confidenceThreshold &&
    input.hasStrongEvidence &&
    input.hasProtectedProperty &&
    input.weakensProtectedProperty &&
    !input.hasEquivalentRegressionTest;

  if (shouldBlock) return "block";
  if (input.riskScore >= 50 || input.confidenceScore < 40) return "warn";
  return "allow";
}
