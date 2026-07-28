import { decideBlock, type BlockDecision } from "@whyguard/domain";
import { detectSensitiveChanges } from "@whyguard/ast-adapter";
import type { Finding } from "@whyguard/contracts";
import {
  buildFinding,
  resetFindingCounterForTests as resetFindingBuilderCounter,
} from "./finding-builder.js";
import { gatherEvidenceForChange, loadActiveContracts } from "./evidence-gathering.js";
import { recordFinding } from "./finding-store.js";

/**
 * `whyguard guard` use case.
 *
 * Unlike `scanDiff`, this does not compare two Git refs. It evaluates a single
 * proposed edit (the "before" content currently on disk/in the repo, vs. the
 * "after" content an agent is about to write) and decides whether Kiro should
 * allow, warn, or block the tool call — deterministically, with no LLM involved,
 * per the block rule.
 */

export type GuardChangeInput = {
  /** Repository root, used to load rationale contracts and trace history if available. */
  repoRoot: string;
  filePath: string;
  beforeContent: string | null;
  afterContent: string | null;
  now?: () => string;
  idGenerator?: () => string;
};

export type GuardFindingDecision = {
  finding: Finding;
  decision: BlockDecision;
};

export type GuardChangeResult = {
  /** The most severe decision across all findings for this change ("block" wins over "warn" over "allow"). */
  decision: BlockDecision;
  findings: GuardFindingDecision[];
  /** Human-readable feedback, ready to print to STDERR when decision is "block". */
  feedback: string;
};

const DECISION_SEVERITY: Record<BlockDecision, number> = { allow: 0, warn: 1, block: 2 };

function combineDecisions(decisions: BlockDecision[]): BlockDecision {
  return decisions.reduce<BlockDecision>(
    (worst, current) => (DECISION_SEVERITY[current] > DECISION_SEVERITY[worst] ? current : worst),
    "allow",
  );
}

/**
 * A change "weakens" its protected property whenever WhyGuard proposed or
 * confirmed one at all — `buildFinding` only assembles `protectedProperties` when
 * the sensitive change already represents a removal/weakening of a guard,
 * validation, or boundary (see `finding-builder.ts`). If there is no protected
 * property, there is nothing to weaken, so `decideBlock` naturally falls through
 * to warn/allow.
 */
function findingToBlockInput(finding: Finding) {
  const hasStrongEvidence = finding.evidence.some((item) => item.strength === "strong");
  const hasProtectedProperty = finding.protectedProperties.length > 0;
  const hasEquivalentRegressionTest = finding.evidence.some((item) => item.type === "test");

  return {
    riskScore: finding.riskScore,
    confidenceScore: finding.confidenceScore,
    hasStrongEvidence,
    hasProtectedProperty,
    weakensProtectedProperty: hasProtectedProperty,
    hasEquivalentRegressionTest,
  };
}

function formatFeedback(blocked: GuardFindingDecision[]): string {
  const lines: string[] = ["WHYGUARD BLOCKED THIS EDIT", ""];

  for (const { finding } of blocked) {
    for (const property of finding.protectedProperties) {
      lines.push("Protected property:", property.statement, "");
    }
    if (finding.evidence.length > 0) {
      lines.push(
        "Historical evidence:",
        ...finding.evidence.map((item) => `- [${item.strength}] ${item.title}`),
        "",
      );
    }
  }

  lines.push(
    "Continue only if the new implementation preserves the property",
    "or adds a regression test that proves an equivalent mechanism.",
  );

  return lines.join("\n");
}

export function resetGuardChangeCountersForTests(): void {
  resetFindingBuilderCounter();
}

export function guardChange(input: GuardChangeInput): GuardChangeResult {
  const { repoRoot, filePath, beforeContent, afterContent } = input;
  const now = input.now ?? (() => new Date().toISOString());
  const idGenerator = input.idGenerator ?? (() => `guard_${now()}`);

  const activeContracts = loadActiveContracts(repoRoot);
  const sensitiveChanges = detectSensitiveChanges({ filePath, beforeContent, afterContent });

  const runId = idGenerator();
  const results: GuardFindingDecision[] = sensitiveChanges.map((change) => {
    const { evidence, matchingContract } = gatherEvidenceForChange(
      repoRoot,
      change,
      activeContracts,
    );
    const finding = buildFinding(runId, change, evidence, matchingContract);
    recordFinding(finding);
    const decision = decideBlock(findingToBlockInput(finding));
    return { finding, decision };
  });

  const decision = combineDecisions(results.map((result) => result.decision));
  const blocked = results.filter((result) => result.decision === "block");
  const feedback =
    decision === "block"
      ? formatFeedback(blocked)
      : results.length === 0
        ? "No sensitive historical-decision changes detected."
        : "No blocking condition met; review findings for details.";

  return { decision, findings: results, feedback };
}
