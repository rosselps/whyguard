import { randomBytes } from "node:crypto";
import { detectSensitiveChanges } from "@whyguard/ast-adapter";
import { getChangedFiles, getFileAtRef, resolveRef, type ChangedFile } from "@whyguard/git-adapter";
import type { Finding, RepositoryRef, ScanReport } from "@whyguard/contracts";
import { parseScanReport } from "@whyguard/contracts";
import { buildFinding } from "./finding-builder.js";
import { gatherEvidenceForChange, loadActiveContracts } from "./evidence-gathering.js";
import { recordFindings } from "./finding-store.js";

/**
 * `whyguard scan` use case.
 *
 * Deterministic only: no network calls, no LLM (this package never imports an
 * llm-adapter). Given a repository root and two refs, this:
 *
 * 1. Lists changed TypeScript/JavaScript files (git-adapter).
 * 2. Detects sensitive AST changes per file (ast-adapter).
 * 3. Gathers evidence for each change (evidence-gathering: matching confirmed
 *    rationale contracts, their existing regression tests, the traced introducing
 *    commit, and issue/PR references in that commit's message).
 * 4. Computes deterministic risk/confidence and assembles a validated Finding
 *    (finding-builder).
 */

export type ScanDiffInput = {
  repoRoot: string;
  base: string;
  head: string;
  source?: "cli" | "kiro" | "github";
  /**
   * Identity to record for the analyzed repository. Defaults to a `local` ref whose
   * name is `repoRoot`.
   *
   * `scanPullRequest` must override this: it analyzes an ephemeral clone, so
   * defaulting would record the throwaway workspace path (e.g.
   * `.tmp/whyguard/whyguard-pr-A9ghPI`) as the repository's identity. That is wrong
   * twice over — the dashboard showed a temp directory instead of `owner/repo`, and
   * once the read API is publicly reachable, persisting absolute server paths leaks
   * the filesystem layout and the operating user's name through a public endpoint.
   */
  repository?: RepositoryRef;
  now?: () => string;
  idGenerator?: () => string;
};

// A per-process random salt, mixed into every generated run id so two different
// OS processes writing to the same shared database (e.g. `apps/cli` and
// `apps/api` both persisting to `data/whyguard.db`) can never produce the same
// id. A plain per-process counter starting at 1 is not enough on its own: it
// guarantees uniqueness *within* one process, but every process's counter
// restarts at 1, so a CLI-generated "run_001" and an API-generated "run_001"
// previously collided — `saveScanReport`'s `DELETE FROM findings WHERE run_id =
// ?` then silently wiped out whichever scan was persisted first. Discovered via
// a live GitHub webhook test overwriting a CLI-run scan in the same database.
const processSalt = randomBytes(4).toString("hex");
let runCounter = 0;
function defaultIdGenerator(): string {
  runCounter += 1;
  return `run_${processSalt}_${runCounter.toString().padStart(3, "0")}`;
}

export function resetScanDiffCountersForTests(): void {
  runCounter = 0;
}

function isSupportedSourceFile(path: string): boolean {
  return /\.(ts|tsx|js|jsx)$/.test(path) && !/\.d\.ts$/.test(path);
}

function relevantChange(change: ChangedFile): boolean {
  return (
    (change.status === "modified" || change.status === "renamed") &&
    isSupportedSourceFile(change.path)
  );
}

export function scanDiff(input: ScanDiffInput): ScanReport {
  const { repoRoot, source = "cli" } = input;
  const now = input.now ?? (() => new Date().toISOString());
  const idGenerator = input.idGenerator ?? defaultIdGenerator;

  const baseSha = resolveRef(repoRoot, input.base);
  const headSha = resolveRef(repoRoot, input.head);

  const changedFiles = getChangedFiles(repoRoot, baseSha, headSha).filter(relevantChange);
  const activeContracts = loadActiveContracts(repoRoot);

  /**
   * Whether a contract's required test still exists *at head*, asked of Git rather than of
   * the filesystem.
   *
   * A pull request scan clones the base branch and never checks the head out, so a
   * filesystem check answered about the base: a pull request that deleted the protecting
   * test kept its "regression test on record" evidence and scored 15 points *lower* than
   * one that left the test alone. Observed on a real pull request — the deployed check
   * reported risk 81 for a change the CLI scored 96.
   */
  const testExistsAtHead = (testPath: string): boolean =>
    getFileAtRef(repoRoot, headSha, testPath) !== null;

  const findings: Finding[] = [];
  const runId = idGenerator();

  for (const changedFile of changedFiles) {
    // A renamed file lives under a different path at `base`; reading it with the head
    // path returns null, which silently made every rename unanalyzable even though
    // `relevantChange` accepts them.
    const beforeContent = getFileAtRef(
      repoRoot,
      baseSha,
      changedFile.previousPath ?? changedFile.path,
    );
    const afterContent = getFileAtRef(repoRoot, headSha, changedFile.path);

    const sensitiveChanges = detectSensitiveChanges({
      filePath: changedFile.path,
      beforeContent,
      afterContent,
    });

    for (const change of sensitiveChanges) {
      const { evidence, matchingContract } = gatherEvidenceForChange(
        repoRoot,
        change,
        activeContracts,
        testExistsAtHead,
      );
      findings.push(buildFinding(runId, change, evidence, matchingContract));
    }
  }

  const report: ScanReport = {
    schemaVersion: 1,
    run: {
      id: runId,
      repository: input.repository ?? { provider: "local", name: repoRoot, root: repoRoot },
      baseSha,
      headSha,
      source,
      status: "completed",
      createdAt: now(),
    },
    findings,
    llmEnabled: false,
  };

  const validated = parseScanReport(report);
  // Record findings in-process so `whyguard.get_finding` / `whyguard.propose_regression_test`
  // can retrieve them later in the same server/process lifetime. See
  // `finding-store.ts` for why this is intentionally non-durable until Phase 5's
  // persistence-adapter exists.
  recordFindings(validated.findings);
  return validated;
}
