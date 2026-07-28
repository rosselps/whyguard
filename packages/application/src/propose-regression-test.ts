import type { Finding, RegressionTestProposal } from "@whyguard/contracts";
import { RegressionTestProposalSchema } from "@whyguard/contracts";
import { getFinding } from "./finding-store.js";

/**
 * `whyguard.propose_regression_test` use case.
 *
 * This is deliberately a template, not a working test: it names the protected
 * property in a `test.todo`/comment so a human fills in the real assertion. rule 9, nothing produced here is ever written to disk or run by
 * WhyGuard itself — the caller (MCP client, CLI, human) decides what to do with
 * the returned `code` string.
 */
export type ProposeRegressionTestInput = {
  findingId: string;
  framework?: string;
};

export class FindingNotFoundError extends Error {
  constructor(findingId: string) {
    super(`No finding recorded for id "${findingId}". Run a scan/guard in this process first.`);
    this.name = "FindingNotFoundError";
  }
}

function suggestedTestPath(finding: Finding): string {
  const base = finding.change.filePath.replace(/\.(ts|tsx|js|jsx)$/, "");
  return `${base}.regression.test.ts`;
}

function buildVitestSkeleton(finding: Finding): string {
  const symbol = finding.change.symbol ?? "the affected behavior";
  const properties =
    finding.protectedProperties.length > 0
      ? finding.protectedProperties.map((property) => `// - ${property.statement}`).join("\n")
      : "// - (no protected property was confirmed yet; state one before writing an assertion)";
  const evidenceLines = finding.evidence
    .map((item) => `// - [${item.strength}] ${item.title} (${item.id})`)
    .join("\n");

  return `import { describe, it } from "vitest";

// Regression test proposal for finding ${finding.id} (${finding.change.filePath}${
    finding.change.symbol ? ` :: ${finding.change.symbol}` : ""
  }).
// Generated deterministically by WhyGuard — this is a skeleton, not a working
// test. A human must fill in the real assertion before this test is trusted.
// never execute a generated test
// automatically; a person must review and complete it first.
//
// Protected propert${finding.protectedProperties.length === 1 ? "y" : "ies"} to preserve:
${properties}
//
// Evidence supporting this:
${evidenceLines || "// - (no evidence recorded)"}

describe("${symbol}", () => {
  it.todo(
    "preserves: ${finding.protectedProperties[0]?.statement ?? "the protected behavior described above"}",
  );
});
`;
}

const TEMPLATE_BUILDERS: Record<string, (finding: Finding) => string> = {
  vitest: buildVitestSkeleton,
  jest: buildVitestSkeleton, // Jest's describe/it/it.todo API is identical for this skeleton.
};

/**
 * Builds a deterministic regression-test skeleton for any `Finding` object,
 * regardless of where it came from — the in-memory `finding-store` (MCP/CLI in
 * the same process) or a row read back from `persistence-adapter` (the
 * dashboard's `GET /reports/:id/regression-test` route, added in Phase 5).
 * This is the pure function `proposeRegressionTest` below wraps; kept separate
 * so a caller with an already-loaded `Finding` never needs to fake an
 * in-memory store entry just to reuse this logic.
 */
export function buildRegressionTestProposal(
  finding: Finding,
  framework: string = "vitest",
): RegressionTestProposal {
  const builder = TEMPLATE_BUILDERS[framework] ?? buildVitestSkeleton;

  const proposal: RegressionTestProposal = {
    framework,
    filePath: suggestedTestPath(finding),
    code: builder(finding),
  };

  return RegressionTestProposalSchema.parse(proposal);
}

/**
 * Builds a deterministic regression-test skeleton for a previously recorded
 * Finding. Throws `FindingNotFoundError` if the finding id is unknown to this
 * process (see `finding-store.ts` for why this is process-local). This is the
 * `whyguard.propose_regression_test` MCP tool's implementation; for a `Finding`
 * you already have in hand (e.g. loaded from `persistence-adapter`), call
 * `buildRegressionTestProposal` directly instead.
 */
export function proposeRegressionTest(input: ProposeRegressionTestInput): RegressionTestProposal {
  const finding = getFinding(input.findingId);
  if (!finding) throw new FindingNotFoundError(input.findingId);

  return buildRegressionTestProposal(finding, input.framework ?? "vitest");
}
