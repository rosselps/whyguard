import type { Evidence } from "@whyguard/contracts";
import type { CommitInfo } from "@whyguard/git-adapter";

/**
 * Extracts issue/PR references from a commit message. No network: only what the commit
 * text already carries.
 *
 * A commit message is `medium` strength at best — it implies a link to an issue but does
 * not confirm the protected behavior the way a human-written contract does.
 */

const ISSUE_REF_PATTERN = /#(\d+)/g;
const CLOSES_KEYWORD_PATTERN = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)/gi;

/**
 * A `(#1234)` at the very end of a subject is the pull request a commit was squash-merged
 * through, added by GitHub. It is a merge artifact, not a reference to a decision, and it
 * carries nothing the commit item does not already carry.
 *
 * Dropping it matters on any real repository: tracing `dispatchHttpRequest` in axios
 * produced 50+ `weak` items harvested from subjects like `chore(deps-dev): bump postcss
 *... (#11099)`, burying the real evidence and inflating the repeated-incident factor
 * with dependency bumps.
 *
 * A closing keyword survives — `(closes #7011)` is a statement, not tooling output.
 */
const SQUASH_MERGE_SUFFIX_PATTERN = /\s*\(#(\d+)\)\s*$/;

export type IssueReference = {
  number: string;
  /** Whether the commit message used a closing keyword ("fixes #481", "closes #481"). */
  isClosingReference: boolean;
};

/** Extracts every `#<number>` reference from a commit's subject + body. */
export function extractIssueReferences(commit: CommitInfo): IssueReference[] {
  const subject = commit.subject.replace(SQUASH_MERGE_SUFFIX_PATTERN, "");
  const text = `${subject}\n${commit.body}`;
  const closingNumbers = new Set<string>();
  for (const match of text.matchAll(CLOSES_KEYWORD_PATTERN)) {
    if (match[1]) closingNumbers.add(match[1]);
  }

  const seen = new Set<string>();
  const references: IssueReference[] = [];
  for (const match of text.matchAll(ISSUE_REF_PATTERN)) {
    const number = match[1];
    if (!number || seen.has(number)) continue;
    seen.add(number);
    references.push({ number, isClosingReference: closingNumbers.has(number) });
  }
  return references;
}

/**
 * Converts issue/PR references found in a commit message into `medium`-strength
 * Evidence items. A closing keyword ("fixes #481") slightly raises confidence that
 * the reference is load-bearing rather than incidental, but never reaches `strong` —
 * only an explicit PR/issue body or a confirmed rationale contract can do that.
 */
export function deriveEvidenceFromCommitMessage(commit: CommitInfo): Evidence[] {
  const references = extractIssueReferences(commit);
  return references.map((ref) => ({
    id: `ev_ref_${ref.number}_${commit.sha.slice(0, 8)}`,
    type: "issue",
    title: `Referenced in commit ${commit.sha.slice(0, 12)}: #${ref.number}`,
    summary: commit.subject,
    sha: commit.sha,
    strength: ref.isClosingReference ? "medium" : "weak",
  }));
}

/**
 * Same derivation across a whole commit history, deduplicated by issue number.
 *
 * `deriveEvidenceFromCommitMessage` is per-commit, so a file whose history mentions the
 * same issue in eight commits yields eight items that all say the same thing. That is
 * correct for `scanDiff`, which only ever looks at one introducing commit, and wrong for
 * `traceSymbol`, which reads up to 50. Keeps the strongest mention of each number, and
 * among equals the oldest commit, since the earliest mention is the one closest to the
 * decision being made.
 */
export function deriveEvidenceFromCommitHistory(commits: CommitInfo[]): Evidence[] {
  const strongestByNumber = new Map<string, Evidence>();
  const rank: Record<Evidence["strength"], number> = { strong: 3, medium: 2, weak: 1 };

  // Oldest first, so an equally strong earlier mention wins by being inserted first.
  for (const commit of [...commits].reverse()) {
    for (const ref of extractIssueReferences(commit)) {
      const candidate = deriveEvidenceFromCommitMessage(commit).find((item) =>
        item.id.startsWith(`ev_ref_${ref.number}_`),
      );
      if (!candidate) continue;
      const current = strongestByNumber.get(ref.number);
      if (!current || rank[candidate.strength] > rank[current.strength]) {
        strongestByNumber.set(ref.number, candidate);
      }
    }
  }

  return [...strongestByNumber.values()].sort((a, b) => rank[b.strength] - rank[a.strength]);
}
