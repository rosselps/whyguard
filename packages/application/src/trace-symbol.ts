import { getFileHistory, resolveRef } from "@whyguard/git-adapter";
import { parseTraceResult, type TraceResult } from "@whyguard/contracts";
import { findMatchingContract, loadRationaleContracts } from "./rationale-contracts.js";
import { deriveEvidenceFromCommitHistory } from "./commit-message-evidence.js";
import { contractToEvidence, mergeEvidence, requiredTestEvidence } from "./evidence-gathering.js";
import { contractToProtectedProperties } from "./finding-builder.js";

/**
 * `whyguard trace <file>:<symbol>` use case and the `trace-historical-decision` skill in `.kiro/skills/`.
 *
 * Unlike `scanDiff`, this does not compare two refs — it reconstructs what is known
 * about a symbol *right now*: its confirmed rationale contract (if any), evidence
 * derived from commit history, and the raw commit history itself, so a developer or
 * agent can decide whether it's safe to touch before making any change.
 *
 * Deterministic only: no network calls, no LLM.
 */

export type TraceSymbolInput = {
  repoRoot: string;
  filePath: string;
  symbol?: string;
  /** Git ref to read history from. Defaults to HEAD. */
  ref?: string;
  maxHistory?: number;
};

export function traceSymbol(input: TraceSymbolInput): TraceResult {
  const { repoRoot, filePath, symbol } = input;
  const ref = input.ref ?? "HEAD";
  resolveRef(repoRoot, ref); // validates the ref exists; throws if not.

  const history = getFileHistory(repoRoot, filePath, input.maxHistory ?? 50);

  const { contracts } = loadRationaleContracts(repoRoot);
  const activeContracts = contracts.filter((contract) => contract.status === "active");
  const matchingContract = findMatchingContract(activeContracts, filePath, symbol);

  // Evidence for a trace comes from the same repository-only sources `scanDiff` uses.
  // `trace` previously relied on the hardcoded `lookupEvidenceFixture`, which meant the
  // one command whose entire job is "tell me what is known about this symbol" could
  // answer with an incident that never happened in this repository. It now reports the
  // confirmed contract's own evidence, its existing regression tests, and whatever the
  // file's commit messages actually reference — and nothing when there is nothing.
  const contractEvidence = matchingContract ? contractToEvidence(matchingContract) : [];
  const testEvidence = matchingContract ? requiredTestEvidence(repoRoot, matchingContract) : [];
  const commitMessageEvidence = deriveEvidenceFromCommitHistory(history);
  const evidence = mergeEvidence(contractEvidence, testEvidence, commitMessageEvidence);

  const protectedProperties = matchingContract
    ? contractToProtectedProperties(matchingContract)
    : [];

  // Same rule `buildFinding` applies: incidental references are not knowledge. Trace
  // previously called any non-empty evidence list "known", so a file whose history
  // merely mentioned pull request numbers reported a confirmed reason it did not have —
  // the opposite of what a command whose entire job is "tell me what is known" should do.
  const hasNonWeakEvidence = evidence.some((item) => item.strength !== "weak");
  const reasonStatus = matchingContract || hasNonWeakEvidence ? "known" : "unknown";

  const result: TraceResult = {
    filePath,
    symbol,
    reasonStatus,
    protectedProperties,
    evidence,
    history: history.map((commit) => ({
      sha: commit.sha,
      subject: commit.subject,
      authorName: commit.authorName,
      date: commit.date,
    })),
    matchingDecisionId: matchingContract?.id,
  };

  return parseTraceResult(result);
}
