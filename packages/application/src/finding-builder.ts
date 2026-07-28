import { randomBytes } from "node:crypto";
import {
  computeConfidenceScore,
  computeRiskScore,
  deriveSeverity,
  proposeProtectedProperty,
  type RiskFactors,
} from "@whyguard/domain";
import type {
  Evidence,
  Finding,
  ProtectedProperty,
  RationaleContract,
  SensitiveChange,
} from "@whyguard/contracts";
import { estimateModuleCriticality } from "./module-criticality.js";

/**
 * Shared Finding-assembly logic, extracted from the original `scan-diff.ts` so both
 * `scanDiff` (two-ref comparison) and `guardChange` (single proposed edit) build identical, consistent Findings from
 * a SensitiveChange + gathered Evidence. Deterministic only — no network, no LLM.
 */

// Same cross-process collision fix as scan-diff.ts's run id generator — see that
// file's comment for the full explanation. A finding id colliding across two
// processes is just as unsafe: `saveScanReport` inserts findings with `id` as a
// primary key, so a second process reusing "fnd_001" would either fail the
// insert outright or (worse, if ids only collided for a subset of rows) silently
// merge two unrelated findings' data.
const processSalt = randomBytes(4).toString("hex");
let findingCounter = 0;
function nextFindingId(): string {
  findingCounter += 1;
  return `fnd_${processSalt}_${findingCounter.toString().padStart(3, "0")}`;
}

export function resetFindingCounterForTests(): void {
  findingCounter = 0;
}

/**
 * Neutral noun phrase naming *what* the change touched, usable both as the subject of
 * "X in <symbol> was removed." and inside "Preserve the behavior that X in <symbol>
 * provided."
 *
 * Written per kind rather than derived from the kind string: mechanically
 * de-underscoring the enum produced sentences like "the removed timeout changed",
 * which reads as broken English in the Check Run and the dashboard — the two places
 * a reviewer actually forms an opinion about whether WhyGuard is trustworthy. The
 * phrases are kept free of "removed"/"weakened" so the surrounding sentence supplies
 * the verb exactly once (an earlier version produced "The removed guard clause... was
 * removed", found while testing against sindresorhus/got).
 */
const CHANGE_SUBJECT_BY_KIND: Record<SensitiveChange["kind"], string> = {
  condition_removed: "the guard clause",
  validation_removed: "the validation call",
  boundary_changed: "the comparison boundary",
  retry_removed: "the retry mechanism",
  timeout_changed: "the timeout value",
  special_case_removed: "the special case",
  test_removed: "the regression test",
};

function describeChangeSubject(kind: SensitiveChange["kind"]): string {
  return CHANGE_SUBJECT_BY_KIND[kind];
}

/**
 * Opening sentence of a finding's explanation, phrased correctly for the kind: a
 * removal reads as "was removed", while a value change reads as "changed from A to B"
 * and includes the actual values, which is the information a reviewer needs first.
 */
function describeChangeSentence(change: SensitiveChange, location: string): string {
  const { kind, before, after } = change;

  if (kind === "timeout_changed" || kind === "boundary_changed") {
    const transition = before && after ? ` (${before} -> ${after})` : "";
    const what = kind === "timeout_changed" ? "A timeout value" : "A comparison boundary";
    return `${what} in ${location} changed${transition}.`;
  }

  if (kind === "retry_removed") {
    // Covers both halves of the pattern: a deleted wrapper and a lowered count.
    const transition =
      after === "(removed)" ? ` (${before} was removed)` : ` (${before} -> ${after})`;
    return `The retry behavior of ${location} was weakened${before ? transition : ""}.`;
  }

  return `${capitalize(describeChangeSubject(kind))} in ${location} was removed.`;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Deterministic semantic-change-magnitude weight per sensitive-change kind. */
const CHANGE_MAGNITUDE_BY_KIND: Record<SensitiveChange["kind"], number> = {
  condition_removed: 85,
  validation_removed: 75,
  boundary_changed: 55,
  retry_removed: 70,
  timeout_changed: 50,
  special_case_removed: 65,
  test_removed: 80,
};

/**
 * Evidence strength for the risk formula, driven by the *strongest* item found rather
 * than the average of all items.
 *
 * Averaging was wrong in a way that showed up immediately on a real repository: a
 * finding backed by a human-confirmed contract (`strong`) plus one incidental commit
 * (`weak`) scored lower than the same finding backed by the contract alone. Additional
 * evidence made WhyGuard *less* sure of something a human had already confirmed.
 * Evidence corroborates; it must never dilute.
 */
function computeEvidenceStrengthFactor(evidence: Evidence[]): number {
  if (evidence.length === 0) return 0;
  const weight: Record<Evidence["strength"], number> = { strong: 100, medium: 60, weak: 30 };
  const strongest = Math.max(...evidence.map((item) => weight[item.strength]));
  const corroborating = evidence.filter((item) => item.strength !== "weak").length - 1;
  return Math.min(100, strongest + Math.max(0, corroborating) * 5);
}

/**
 * Derives the risk factors for the formula.
 *
 * `matchingContract` is load-bearing, not decorative. An `active` rationale contract
 * means a human wrote down that this behavior must be preserved and pointed at this
 * exact file/symbol — that is the strongest statement the tool
 * accepts. Ignoring it here (as an earlier version did) meant a confirmed decision
 * could never raise risk above the block threshold, so contracts could not actually
 * protect anything for the lower-magnitude patterns. Found on a real repository: an
 * active contract on a sampling interval produced a warning, not a block, which
 * defeats the entire point of writing the contract.
 *
 * The formula's weights and thresholds are unchanged — only how the factors are
 * derived from what is actually known.
 */
function buildRiskFactors(
  change: SensitiveChange,
  evidence: Evidence[],
  matchingContract: RationaleContract | undefined,
): RiskFactors {
  const issueCount = evidence.filter((item) => item.type === "issue").length;
  const estimatedCriticality = estimateModuleCriticality(change.filePath);

  return {
    // A human explicitly scoping a decision to this file is a stronger signal about
    // the module's criticality than any path-name heuristic. Take the higher of the two
    // rather than replacing the estimate, so a payments module does not get *less*
    // critical just because someone documented it.
    moduleCriticality: matchingContract ? Math.max(estimatedCriticality, 90) : estimatedCriticality,
    historicalSeverity: matchingContract
      ? 100
      : evidence.some((item) => item.strength === "strong")
        ? 90
        : evidence.length > 0
          ? 50
          : 20,
    evidenceStrength: computeEvidenceStrengthFactor(evidence),
    // No coverage-detection adapter yet: assume the regression test is missing
    // unless evidence explicitly includes a "test" item.
    missingRegressionTest: evidence.some((item) => item.type === "test") ? 0 : 100,
    semanticChangeMagnitude: CHANGE_MAGNITUDE_BY_KIND[change.kind],
    repeatedIncidentSignal: issueCount > 1 ? 100 : issueCount === 1 ? 50 : 0,
  };
}

export function contractToProtectedProperties(contract: RationaleContract): ProtectedProperty[] {
  return contract.must_preserve.map((statement, index) => ({
    id: `pp_decision_${contract.id}_${index}`,
    statement,
    category: "business_rule",
    status: "confirmed",
  }));
}

export function buildFinding(
  runId: string,
  change: SensitiveChange,
  evidence: Evidence[],
  matchingContract: RationaleContract | undefined,
): Finding {
  const riskFactors = buildRiskFactors(change, evidence, matchingContract);
  const riskScore = computeRiskScore(riskFactors);
  const confidenceScore = computeConfidenceScore(evidence);
  const severity = deriveSeverity(riskScore);
  // Per the evidence policy, a temporal correlation without explicit
  // explanation (i.e. only `weak` evidence) must not be enough to call the reason
  // "known" — that would misrepresent a guess as a confirmed fact. A confirmed
  // rationale contract always counts as known, since a human already reviewed it.
  const hasNonWeakEvidence = evidence.some((item) => item.strength !== "weak");
  const reasonStatus = hasNonWeakEvidence || matchingContract ? "known" : "unknown";

  const location = change.symbol ?? change.filePath;

  const protectedProperties = matchingContract
    ? contractToProtectedProperties(matchingContract)
    : reasonStatus === "known"
      ? [
          // Derived from the change itself, never from a path-keyed lookup table. An
          // earlier version substituted a hardcoded idempotency statement whenever the
          // path ended in `src/payments/create-order.ts`, which would have put words in
          // a real repository's mouth about a decision nobody there made.
          proposeProtectedProperty(
            `Preserve the behavior that ${describeChangeSubject(change.kind)} in ${location} provided.`,
            "business_rule",
          ),
        ]
      : [];

  const explanation = matchingContract
    ? `This change affects a behavior covered by the confirmed decision "${matchingContract.id}": ${matchingContract.reason.trim()}`
    : reasonStatus === "known"
      ? `${describeChangeSentence(change, location)} Historical evidence indicates this protected a known behavior: ${
          protectedProperties[0]?.statement ?? ""
        }`
      : "No reliable historical reason was found. Manual review is required.";

  const recommendation = matchingContract
    ? `Preserve every property listed in the "${matchingContract.id}" decision, or update the decision file if it is intentionally being replaced.`
    : reasonStatus === "known"
      ? "Preserve the protected property or add an equivalent mechanism and regression test before merging."
      : "Confirm with the code owner whether this change is safe; no historical evidence was found.";

  return {
    id: nextFindingId(),
    runId,
    change,
    evidenceIds: evidence.map((item) => item.id),
    evidence,
    protectedProperties,
    riskScore,
    confidenceScore,
    severity,
    reasonStatus,
    explanation,
    recommendation,
  };
}
