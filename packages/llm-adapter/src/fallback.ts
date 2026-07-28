import type { Finding, LlmExplanation } from "@whyguard/contracts";

/**
 * Deterministic fallback explanation:
 * "If Bedrock is unavailable, produce a deterministic template from the finding
 * and evidence. The demo must still work." This is the *only* path exercised
 * when `WHYGUARD_LLM_ENABLED=false` (the CLI/test default), and the safety net
 * whenever a real Bedrock call fails or returns something that doesn't validate.
 *
 * Every field is derived directly from `finding` — no invention, no network,
 * no randomness — so this function is safe to call from anywhere (CLI, API,
 * tests) without an AWS credential in scope.
 */
export function buildFallbackExplanation(
  finding: Finding,
  now: () => string = defaultNow,
): LlmExplanation {
  const protectedProperty =
    finding.protectedProperties[0]?.statement ??
    "No protected property has been confirmed for this change yet.";

  const usedEvidenceIds =
    finding.evidence.length > 0 ? finding.evidence.map((item) => item.id) : ["none"];

  return {
    summary: finding.explanation,
    protectedProperty,
    recommendation: finding.recommendation,
    usedEvidenceIds,
    uncertainty:
      finding.reasonStatus === "unknown"
        ? "No reliable historical reason was found; this is a template, not a grounded explanation."
        : `Deterministic template built from ${finding.evidence.length} evidence item(s); not reviewed by a model.`,
    source: "fallback",
    generatedAt: now(),
  };
}

function defaultNow(): string {
  return new Date().toISOString();
}
