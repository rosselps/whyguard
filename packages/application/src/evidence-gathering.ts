import { existsSync } from "node:fs";
import { join } from "node:path";
import { findCommitsByPickaxe, type CommitInfo } from "@whyguard/git-adapter";
import type { Evidence, RationaleContract, SensitiveChange } from "@whyguard/contracts";
import { findMatchingContract, loadRationaleContracts } from "./rationale-contracts.js";
import {
  deriveEvidenceFromCommitMessage,
  extractIssueReferences,
} from "./commit-message-evidence.js";

/**
 * Evidence gathering, shared by `scanDiff` and `guardChange` so both reach a verdict from
 * the same inputs.
 *
 * Every source reads the target repository and nothing else: a matching confirmed
 * rationale contract, the introducing commit (traced via `git log -S`), issue/PR
 * references in that commit's message, and the contract's declared regression tests when
 * they exist on disk. Never invent a reason — fabricated evidence is the one failure mode
 * this tool cannot afford.
 */

/**
 * Picks the literal source fragment to feed `git log -S` for a given change kind.
 *
 * The fragment has to be text that genuinely existed in the file before the edit,
 * because the pickaxe searches for occurrences of that exact string. Each kind stores
 * its `before` in a different shape (`makeChange` in `@whyguard/ast-adapter`), so the
 * fragment is derived per kind rather than assumed:
 *
 * - `condition_removed` — `before` is `if (<condition>) {... }`; search the condition.
 * - `retry_removed`/`timeout_changed` — `before` is either `name = value` (a numeric
 *   setting) or `callee(...)` (a removed retry wrapper); search the name or callee,
 *   which is the part that appears verbatim in the source.
 *
 * Returns null for kinds whose `before` is not a reliable literal, so no evidence is
 * claimed from a search that would match the wrong thing. Never invent a reason.
 */
function pickaxeFragmentFor(change: SensitiveChange): string | null {
  if (!change.before) return null;

  if (change.kind === "condition_removed") {
    return /if \((.+)\) \{/.exec(change.before)?.[1]?.trim() ?? null;
  }

  if (change.kind === "retry_removed" || change.kind === "timeout_changed") {
    // "withRetry(...)" -> "withRetry"
    const removedCall = /^(.+)\(\.\.\.\)$/.exec(change.before);
    if (removedCall?.[1]) return removedCall[1].trim();

    // "REQUEST_TIMEOUT_MS = 30000" -> "REQUEST_TIMEOUT_MS". The name is searched
    // rather than the value: a bare number like "3" matches far too much history to
    // be meaningful evidence, while the setting's name is distinctive.
    const namedSetting = /^(.+?)\s*=\s*/.exec(change.before);
    const name = namedSetting?.[1]?.trim();
    // Call-argument settings are keyed "callee#index" (see extractNamedNumericSettings);
    // strip the positional suffix so the callee itself is searched.
    return name ? (name.split("#")[0] ?? null) : null;
  }

  return null;
}

/**
 * Traces the commit that introduced the affected behavior, using Git's `git log -S`
 * pickaxe. Takes a literal fragment of the changed code (see
 * `pickaxeFragmentFor`) to search full history and returns the oldest matching commit
 * (the one most likely to have introduced it).
 *
 * Requires a real Git repository at `repoRoot` — returns null when there is none (e.g. an
 * in-memory guard check with no committed history yet).
 */
export function traceIntroducingCommit(
  repoRoot: string,
  change: SensitiveChange,
): CommitInfo | null {
  const fragment = pickaxeFragmentFor(change);
  if (!fragment) return null;

  try {
    const matches = findCommitsByPickaxe(repoRoot, fragment, change.filePath);
    if (matches.length === 0) return null;
    // `git log` returns commits newest-first; the oldest match is the introducing commit.
    return matches[matches.length - 1] ?? null;
  } catch {
    return null;
  }
}

/**
 * Converts the introducing commit itself into Evidence. Its strength depends on
 * whether the commit message actually explains anything (an issue/PR reference,
 * ideally a closing keyword) — merely knowing *which* commit changed the code,
 * with no explanatory message, is `weak` per the evidence rubric: a
 * temporal correlation without explicit explanation. This prevents every traceable
 * commit from automatically making a finding "known".
 */
export function commitToEvidence(commit: CommitInfo): Evidence {
  const hasClosingReference = extractIssueReferences(commit).some((ref) => ref.isClosingReference);
  const strength: Evidence["strength"] = hasClosingReference ? "medium" : "weak";

  return {
    id: `ev_commit_${commit.sha.slice(0, 12)}`,
    type: "commit",
    title: `Commit ${commit.sha.slice(0, 12)}: ${commit.subject}`,
    summary: commit.body || undefined,
    sha: commit.sha,
    strength,
  };
}

/**
 * Turns a contract's declared `required_tests` into `type: "test"` Evidence — but only
 * for paths that actually exist in the repository.
 *
 * This is the escape route every block message offers ("add a regression test proving an
 * equivalent mechanism"), and it is what makes `required_tests` load-bearing rather than
 * documentation.
 *
 * Existence is deliberately the only check: WhyGuard does not run tests, parse them, or
 * measure coverage, so claiming to verify that a test *proves* a property would be a
 * bigger promise than it can keep. It honors the contract's written statement instead.
 * `medium`, not `strong`, so the finding stays visible as a warning rather than
 * disappearing.
 *
 * `testExists` exists because "the repository" is not always the working tree. A pull
 * request scan clones the base branch and never checks the head out, so a filesystem
 * check answers about the base — and a pull request that deletes the protecting test
 * would score *lower* than one that leaves it in place, which is backwards. The caller
 * that knows which ref is under review supplies the lookup for that ref.
 */
export function requiredTestEvidence(
  repoRoot: string,
  contract: RationaleContract,
  testExists: (testPath: string) => boolean = (testPath) => existsSync(join(repoRoot, testPath)),
): Evidence[] {
  return contract.required_tests
    .filter((testPath) => testExists(testPath))
    .map((testPath) => ({
      id: `ev_test_${contract.id}_${testPath.replace(/[^a-zA-Z0-9]+/g, "_")}`,
      type: "test" as const,
      title: `Regression test on record: ${testPath}`,
      summary:
        `Declared by the "${contract.id}" decision as proving: ` +
        `${contract.must_preserve[0] ?? contract.reason.trim()}`,
      strength: "medium" as const,
    }));
}

/**
 * Converts a confirmed rationale contract's declared evidence into Evidence items.
 * A human already confirmed this contract (only `active` contracts reach this
 * function — see `findMatchingContract`), so its declared evidence is treated as
 * `strong` per the rubric, even though the contract only stores a
 * bare type+id reference rather than a full evidence record.
 */
export function contractToEvidence(contract: RationaleContract): Evidence[] {
  return contract.evidence.map((ref) => ({
    id: `ev_decision_${contract.id}_${ref.type}_${ref.id}`,
    type: ref.type,
    title: `${contract.id}: confirmed ${ref.type} #${ref.id}`,
    summary: contract.reason,
    strength: "strong",
  }));
}

/** Merges evidence lists, de-duplicating by `id` (first occurrence wins). */
export function mergeEvidence(...groups: Evidence[][]): Evidence[] {
  const byId = new Map<string, Evidence>();
  for (const group of groups) {
    for (const item of group) {
      if (!byId.has(item.id)) byId.set(item.id, item);
    }
  }
  return [...byId.values()];
}

export type GatherEvidenceResult = {
  evidence: Evidence[];
  matchingContract: RationaleContract | undefined;
};

/**
 * Gathers all available evidence for a single SensitiveChange from every deterministic
 * source, all of them inside the target repository: a matching confirmed rationale
 * contract, that contract's `required_tests` that still exist, the traced introducing
 * commit (when `repoRoot` is a real Git repository with history), and issue/PR
 * references in that commit's message.
 *
 * `testExists` overrides where "still exist" is looked up; see `requiredTestEvidence`.
 */
export function gatherEvidenceForChange(
  repoRoot: string,
  change: SensitiveChange,
  activeContracts: RationaleContract[],
  testExists?: (testPath: string) => boolean,
): GatherEvidenceResult {
  const introducingCommit = traceIntroducingCommit(repoRoot, change);
  const commitEvidence = introducingCommit ? [commitToEvidence(introducingCommit)] : [];
  const commitMessageEvidence = introducingCommit
    ? deriveEvidenceFromCommitMessage(introducingCommit)
    : [];

  const matchingContract = findMatchingContract(activeContracts, change.filePath, change.symbol);
  const contractEvidence = matchingContract ? contractToEvidence(matchingContract) : [];
  const testEvidence = matchingContract
    ? requiredTestEvidence(repoRoot, matchingContract, testExists)
    : [];

  const evidence = mergeEvidence(
    contractEvidence,
    testEvidence,
    commitEvidence,
    commitMessageEvidence,
  );

  return { evidence, matchingContract };
}

export type ActiveContractsResult = {
  contracts: RationaleContract[];
  /** Decision files that exist but failed schema validation, and why. */
  invalid: { file: string; error: string }[];
};

/**
 * Loads the `active` rationale contracts for a repository root, keeping the list of
 * files that failed validation.
 *
 * Callers must surface `invalid` somewhere a human will see it. A contract is the only
 * input that turns a warning into a block, so a file that silently fails to load looks
 * exactly like protection that works — right up to the moment it doesn't. An unquoted
 * colon inside a `must_preserve` item is enough to trigger it: YAML reads the item as a
 * map, the schema rejects it, and the repository loses enforcement.
 */
export function loadActiveContractsWithDiagnostics(repoRoot: string): ActiveContractsResult {
  const { contracts, invalid } = loadRationaleContracts(repoRoot);
  return { contracts: contracts.filter((contract) => contract.status === "active"), invalid };
}

/** Loads only the `active` rationale contracts, discarding validation diagnostics. */
export function loadActiveContracts(repoRoot: string): RationaleContract[] {
  return loadActiveContractsWithDiagnostics(repoRoot).contracts;
}
