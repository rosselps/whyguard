import type { Finding } from "@whyguard/contracts";

/**
 * Builds the prompt sent to the model. Scoped to exactly this finding's data —
 * the change, its evidence, and its protected properties — never the whole
 * repository: "The model receives
 * selected snippets and evidence, not the entire repository."
 *
 * The prompt explicitly lists the allowed/forbidden tasks so a
 * well-behaved model is nudged toward the right shape before validation even
 * runs — validation in `explain-finding.ts` is still the actual enforcement,
 * not this text.
 */
export function buildExplanationPrompt(finding: Finding): string {
  const evidenceBlock = finding.evidence
    .map((item) => `- [${item.id}] (${item.strength}) ${item.type}: ${item.title}`)
    .join("\n");
  const protectedPropertiesBlock = finding.protectedProperties
    .map((property) => `- ${property.statement} (status: ${property.status})`)
    .join("\n");

  return `You are assisting WhyGuard, a tool that protects historical technical decisions in code.

You will summarize a code change and its evidence. Follow these rules exactly:
- Only use the evidence IDs listed below. Never invent an issue, PR, or commit.
- Separate the historical reason (why the code existed) from its current implementation.
- Do not assert causality beyond what the evidence supports.
- If evidence is weak or absent, say so plainly in "uncertainty".
- Respond with ONLY a JSON object matching this exact shape, no other text:
{
  "summary": string,
  "protectedProperty": string,
  "recommendation": string,
  "usedEvidenceIds": string[],
  "uncertainty": string,
  "proposedTest": string (optional)
}

Change:
- File: ${finding.change.filePath}
- Symbol: ${finding.change.symbol ?? "(unknown)"}
- Kind: ${finding.change.kind}
- Severity: ${finding.severity}
- Risk score: ${finding.riskScore}
- Confidence score: ${finding.confidenceScore}
- Reason status: ${finding.reasonStatus}

Evidence (only cite these IDs):
${evidenceBlock || "(none)"}

Protected properties already known:
${protectedPropertiesBlock || "(none confirmed yet)"}
`;
}
