import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  getFileAtRef,
  getStagedFileContent,
  getUncommittedChangedFiles,
  type UncommittedScope,
} from "@whyguard/git-adapter";
import type { BlockDecision } from "@whyguard/domain";
import { guardChange, type GuardFindingDecision } from "./guard-change.js";

/**
 * Re-exported so callers (the CLI, the API) can name this scope without taking a
 * direct dependency on `@whyguard/git-adapter` — apps compose application use cases
 * and must not reach into adapters's dependency rules.
 */
export type { UncommittedScope } from "@whyguard/git-adapter";

/**
 * `whyguard verify` use case: evaluates work that exists in the checkout but is
 * **not committed yet**.
 *
 * Checks the *result* of an edit rather than the intent, at two moments where an agent
 * no longer gets a vote: `scope: "working-tree"` from a Kiro `Stop` hook, and
 * `scope: "staged"` from a Git `pre-commit` hook, where Git aborts the commit itself.
 *
 * Unlike `scanDiff` there is no head ref: "before" is the committed content at `HEAD`,
 * "after" is the uncommitted content.
 */

/** File extensions WhyGuard's detector understands (MVP scope: TS/JS only). */
const ANALYZABLE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];

function isAnalyzable(filePath: string): boolean {
  return ANALYZABLE_EXTENSIONS.some((extension) => filePath.endsWith(extension));
}

export type VerifyUncommittedWorkInput = {
  repoRoot: string;
  /** Defaults to `"working-tree"` (the Stop-hook scope). */
  scope?: UncommittedScope;
};

export type VerifyUncommittedWorkFileResult = {
  filePath: string;
  decision: BlockDecision;
  findings: GuardFindingDecision[];
};

export type VerifyUncommittedWorkResult = {
  /** Worst decision across every analyzed file ("block" wins over "warn" over "allow"). */
  decision: BlockDecision;
  /** Files that were actually analyzed (analyzable extension, readable before/after). */
  analyzedFilePaths: string[];
  /** Per-file results, only for files that produced at least one finding. */
  files: VerifyUncommittedWorkFileResult[];
  /** Human-readable report, ready to print. */
  report: string;
};

const DECISION_SEVERITY: Record<BlockDecision, number> = { allow: 0, warn: 1, block: 2 };

function worstDecision(decisions: BlockDecision[]): BlockDecision {
  return decisions.reduce<BlockDecision>(
    (worst, current) => (DECISION_SEVERITY[current] > DECISION_SEVERITY[worst] ? current : worst),
    "allow",
  );
}

function readAfterContent(
  repoRoot: string,
  filePath: string,
  scope: UncommittedScope,
): string | null {
  if (scope === "staged") {
    return getStagedFileContent(repoRoot, filePath);
  }
  try {
    return readFileSync(join(repoRoot, filePath), "utf-8");
  } catch {
    return null;
  }
}

function formatReport(
  scope: UncommittedScope,
  decision: BlockDecision,
  files: VerifyUncommittedWorkFileResult[],
  analyzedCount: number,
): string {
  const scopeLabel = scope === "staged" ? "staged changes" : "uncommitted changes";

  if (decision !== "block") {
    const findingCount = files.reduce((total, file) => total + file.findings.length, 0);
    if (findingCount === 0) {
      return `WhyGuard: no historical-decision risk found in ${scopeLabel} (${analyzedCount} file(s) analyzed).`;
    }
    return `WhyGuard: ${findingCount} non-blocking finding(s) in ${scopeLabel} (${analyzedCount} file(s) analyzed). Review before merging.`;
  }

  const lines: string[] = [
    "WHYGUARD BLOCKED THIS COMMIT",
    "",
    `Protected historical behavior was removed in ${scopeLabel}:`,
    "",
  ];

  for (const file of files) {
    const blocked = file.findings.filter((entry) => entry.decision === "block");
    if (blocked.length === 0) continue;

    lines.push(`${file.filePath}`);
    for (const { finding } of blocked) {
      if (finding.change.symbol) {
        lines.push(`  symbol: ${finding.change.symbol} (${finding.change.kind})`);
      }
      for (const property of finding.protectedProperties) {
        lines.push(`  protected property: ${property.statement}`);
      }
      for (const evidence of finding.evidence) {
        lines.push(`  evidence: [${evidence.strength}] ${evidence.title}`);
      }
    }
    lines.push("");
  }

  lines.push(
    "Preserve the property, or add a regression test proving an equivalent",
    "mechanism, then commit again.",
  );

  return lines.join("\n");
}

export function verifyUncommittedWork(
  input: VerifyUncommittedWorkInput,
): VerifyUncommittedWorkResult {
  const { repoRoot } = input;
  const scope = input.scope ?? "working-tree";

  const changedFiles = getUncommittedChangedFiles(repoRoot, scope).filter(
    // A deleted file has no "after" content to analyze. Whole-file deletion is a
    // different (and much more visible) act than quietly removing a guard inside
    // an otherwise-intact file, and is out of MVP detector scope.
    (file) => file.status !== "deleted" && isAnalyzable(file.path),
  );

  const analyzedFilePaths: string[] = [];
  const files: VerifyUncommittedWorkFileResult[] = [];

  for (const changedFile of changedFiles) {
    // Same rename caveat as `scanDiff`: at HEAD the file still has its old path.
    const beforeContent = getFileAtRef(
      repoRoot,
      "HEAD",
      changedFile.previousPath ?? changedFile.path,
    );
    const afterContent = readAfterContent(repoRoot, changedFile.path, scope);

    // A file with no committed version (newly added) has no protected history yet;
    // an unreadable "after" means there is nothing trustworthy to compare.
    if (beforeContent === null || afterContent === null) continue;

    analyzedFilePaths.push(changedFile.path);

    const result = guardChange({
      repoRoot,
      filePath: changedFile.path,
      beforeContent,
      afterContent,
    });

    if (result.findings.length > 0) {
      files.push({
        filePath: changedFile.path,
        decision: result.decision,
        findings: result.findings,
      });
    }
  }

  const decision = worstDecision(files.map((file) => file.decision));

  return {
    decision,
    analyzedFilePaths,
    files,
    report: formatReport(scope, decision, files, analyzedFilePaths.length),
  };
}
