import type { Finding, LlmExplanation } from "@whyguard/contracts";
import { LlmExplanationSchema } from "@whyguard/contracts";
import type { BedrockInvoker } from "./bedrock-invoker.js";
import { buildFallbackExplanation } from "./fallback.js";
import { buildExplanationPrompt } from "./prompt.js";

/**
 * `explainFinding` — the single entry point this package exposes for turning a
 * Finding into an `LlmExplanation`.
 *
 * Deterministic-first fallback rule: if `invoker` is
 * omitted (Bedrock disabled/not configured), this always returns the
 * deterministic fallback — never attempts a network call. When an invoker is
 * provided, every one of these makes it fall back instead of throwing:
 *   - the invoker throws (network error, throttling, auth failure,...);
 *   - the model's response isn't valid JSON;
 *   - the parsed JSON fails `LlmExplanationSchema`;
 *   - the model cites an evidence ID that isn't in `finding.evidence`
 *     (the check `LlmExplanationSchema` cannot express on its own —: "Reject output referencing unknown evidence IDs").
 *
 * This function never throws for a Bedrock-side failure. It only throws if
 * `now` (if injected) throws, which should never happen in practice.
 */
export type ExplainFindingOptions = {
  invoker?: BedrockInvoker;
  now?: () => string;
};

export async function explainFinding(
  finding: Finding,
  options: ExplainFindingOptions = {},
): Promise<LlmExplanation> {
  if (!options.invoker) {
    return buildFallbackExplanation(finding, options.now);
  }

  try {
    const prompt = buildExplanationPrompt(finding);
    const rawText = await options.invoker.invoke(prompt);
    const parsedJson = extractJson(rawText);
    if (typeof parsedJson !== "object" || parsedJson === null) {
      throw new Error("Model response JSON was not an object.");
    }
    const candidate = {
      ...parsedJson,
      source: "bedrock" as const,
      generatedAt: (options.now ?? (() => new Date().toISOString()))(),
    };

    const validated = LlmExplanationSchema.parse(candidate);
    assertEvidenceIdsAreKnown(validated, finding);
    return validated;
  } catch {
    // Any failure at any step above — network, parsing, schema, or an
    // evidence ID that doesn't exist — falls back deterministically. The
    // failure reason is intentionally not surfaced to the caller as an error;
    //, "the demo must still work," so a Bedrock hiccup must
    // never propagate as a thrown exception.
    return buildFallbackExplanation(finding, options.now);
  }
}

/**
 * Models are instructed to respond with only JSON, but are not always
 * cooperative (leading/trailing prose, markdown code fences). Extracts the
 * first top-level `{...}` block rather than trusting `rawText` is pure JSON.
 */
function extractJson(rawText: string): unknown {
  const start = rawText.indexOf("{");
  const end = rawText.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    throw new Error("Model response did not contain a JSON object.");
  }
  return JSON.parse(rawText.slice(start, end + 1));
}

/**
 * "Reject output referencing unknown
 * evidence IDs." `LlmExplanationSchema` only checks shape (non-empty strings);
 * this checks content against the finding actually passed in.
 */
function assertEvidenceIdsAreKnown(explanation: LlmExplanation, finding: Finding): void {
  const knownIds = new Set(finding.evidence.map((item) => item.id));
  const hasUnknownId = explanation.usedEvidenceIds.some((id) => !knownIds.has(id));
  if (hasUnknownId) {
    throw new Error("Model output referenced an evidence ID not present in the finding.");
  }
}
