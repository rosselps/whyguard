import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cloneRepository,
  fetchRefspec,
  pullRequestHeadRefspec,
  resolveRef,
} from "@whyguard/git-adapter";
import {
  getPullRequestRefs,
  publishCheckRun,
  type PullRequestRefs,
  type CheckRunAnnotation,
  type CheckRunConclusion,
} from "@whyguard/github-adapter";
import type { Octokit } from "@octokit/rest";
import { parseScanReport } from "@whyguard/contracts";
import type { Finding, RationaleContract, ScanReport } from "@whyguard/contracts";
import { scanDiff } from "./scan-diff.js";
import { loadActiveContractsWithDiagnostics } from "./evidence-gathering.js";

/**
 * `scanPullRequest` use case.
 *
 * 1. Fetches base/head SHAs for the PR via the GitHub API (github-adapter).
 * 2. Clones the repository into a unique temporary workspace.
 * 3. Fetches the PR's head ref explicitly (covers forked-PR heads that a plain
 *    clone of the base repository cannot reach).
 * 4. Runs the same deterministic `scanDiff` core used by the CLI/MCP server.
 * 5. Publishes a GitHub Check Run summarizing the findings.
 * 6. Deletes the temporary workspace in a `finally` block.
 *
 * The only GitHub-specific pieces are steps 1, 3, and 5 — everything else reuses
 * the exact same deterministic core as `scanDiff` for local/Kiro use cases.
 */

export type ScanPullRequestInput = {
  client: Octokit;
  owner: string;
  repo: string;
  pullNumber: number;
  /**
   * Clone URL for the repository, typically including a short-lived installation
   * token (e.g. `https://x-access-token:<token>@github.com/<owner>/<repo>.git`).
   * Never logged as-is by git-adapter (credentials are redacted on error).
   */
  cloneUrl: string;
  /** Directory under which a unique temporary workspace is created. */
  tempRoot?: string;
  /**
   * Refuse to clone a base repository larger than this, in kilobytes. Defaults to
   * `DEFAULT_MAX_REPOSITORY_SIZE_KB`. Set to `0` to disable the guard entirely.
   */
  maxRepositorySizeKb?: number;
  now?: () => string;
};

export type ScanPullRequestResult = {
  report: ScanReport;
  checkRun: { id: number; htmlUrl: string | null };
  /**
   * Every `active` rationale contract visible in the cloned repository at scan
   * time. Exposed so a caller with a persistence layer (e.g. `apps/api`) can
   * cache them (`upsertDecision`) before the ephemeral clone workspace is
   * deleted — `scanPullRequest` itself never depends on `persistence-adapter`,
   * per the ports-and-adapters rule that `application` only depends on `domain`
   * and `contracts`.
   */
  decisions: RationaleContract[];
};

/**
 * Default ceiling on the base repository size WhyGuard will clone, in kilobytes
 * (~2 GB).
 *
 * Because clones carry full history (see `cloneRepository`), disk usage is set by the
 * repository rather than by the size of the Pull Request. Installing the App on a large
 * monorepo would make every PR event try to write gigabytes. A refusal that says so
 * beats a disk-full error four minutes in.
 *
 * Chosen generously: a blast-radius limit, not a policy about which projects deserve
 * analysis.
 */
export const DEFAULT_MAX_REPOSITORY_SIZE_KB = 2 * 1024 * 1024;

/**
 * Appends a warning to the Check Run body for decision files that failed to load.
 *
 * The Pull Request is the only place maintainers reliably look, and a broken decision file
 * is invisible everywhere else: protection silently stops and the Check still reports
 * success.
 */
function formatInvalidDecisionsNote(invalid: { file: string; error: string }[]): string {
  if (invalid.length === 0) return "";

  const lines = [
    "",
    "---",
    "",
    `### ${invalid.length} decision file(s) could not be loaded`,
    "",
    "Behavior these were meant to protect is **not** protected in this analysis:",
    "",
  ];
  for (const entry of invalid) {
    lines.push(`- \`${entry.file}\` — ${entry.error}`);
  }
  lines.push(
    "",
    "A common cause is an unquoted colon inside a list item, which YAML reads as a",
    "nested key instead of text. Quote the whole line to fix it.",
  );
  return lines.join("\n");
}

function severityToConclusion(findings: Finding[]): CheckRunConclusion {
  if (findings.some((finding) => finding.severity === "critical")) return "action_required";
  if (findings.length > 0) return "neutral";
  return "success";
}

function findingToAnnotation(finding: Finding): CheckRunAnnotation {
  const line = Math.max(1, finding.change.lines.start);
  const endLine = Math.max(line, finding.change.lines.end);
  const level: CheckRunAnnotation["annotationLevel"] =
    finding.severity === "critical" || finding.severity === "high" ? "failure" : "warning";

  const property = finding.protectedProperties[0]?.statement;
  const message = property
    ? `${finding.explanation}\n\nProtected property: ${property}\n\nRecommendation: ${finding.recommendation}`
    : `${finding.explanation}\n\nRecommendation: ${finding.recommendation}`;

  return {
    path: finding.change.filePath,
    startLine: line,
    endLine,
    annotationLevel: level,
    title: `WhyGuard: ${finding.change.kind.replace(/_/g, " ")}`,
    message,
  };
}

/** Formats the Check Run body per the shape. */
function formatCheckRunSummary(findings: Finding[]): { summary: string; text: string } {
  if (findings.length === 0) {
    return {
      summary: "No sensitive historical-decision changes were detected in this Pull Request.",
      text: "",
    };
  }

  const lines: string[] = [
    `WhyGuard found ${findings.length} finding(s) that may affect historically protected behavior.`,
    "",
  ];

  for (const finding of findings) {
    lines.push(
      `### ${finding.change.filePath}${finding.change.symbol ? ` — ${finding.change.symbol}` : ""}`,
    );
    lines.push(
      `- Severity: **${finding.severity}** (risk ${finding.riskScore}, confidence ${finding.confidenceScore})`,
    );
    lines.push(`- Reason: ${finding.reasonStatus}`);
    for (const property of finding.protectedProperties) {
      lines.push(`- Protected property: ${property.statement}`);
    }
    if (finding.evidence.length > 0) {
      lines.push(
        `- Evidence: ${finding.evidence.map((item) => `[${item.strength}] ${item.title}`).join("; ")}`,
      );
    }
    lines.push(`- Recommendation: ${finding.recommendation}`);
    lines.push("");
  }

  return {
    summary: `${findings.length} finding(s) — see details below.`,
    text: lines.join("\n"),
  };
}

/**
 * Publishes a Check Run explaining that the repository was not analyzed, and returns a
 * report marked `failed` with no findings.
 *
 * `failed`, not `completed`: a skipped scan recorded as completed with zero findings is
 * indistinguishable from one that genuinely found nothing, which would have the tool
 * claiming "this PR is fine" about code it never read.
 */
async function skipOversizedRepository(args: {
  client: Octokit;
  owner: string;
  repo: string;
  prRefs: PullRequestRefs;
  sizeLimitKb: number;
  now: () => string;
}): Promise<ScanPullRequestResult> {
  const { client, owner, repo, prRefs, sizeLimitKb, now } = args;
  const actualMb = Math.round(prRefs.baseRepoSizeKb / 1024);
  const limitMb = Math.round(sizeLimitKb / 1024);

  const summary =
    `WhyGuard did not analyze this Pull Request: ${owner}/${repo} is about ${actualMb} MB, ` +
    `above the configured ${limitMb} MB limit.`;
  const text = [
    "WhyGuard clones full repository history because its evidence engine traces the",
    "commit that *introduced* the behavior being changed. That makes disk usage a",
    "function of the repository, not of the Pull Request, so a size limit protects the",
    "analysis host from being filled by a single large repository.",
    "",
    "This Check reports a failure rather than success on purpose: nothing was analyzed,",
    "so nothing should be read as approved.",
    "",
    `Raise \`WHYGUARD_MAX_REPO_SIZE_MB\` above ${actualMb} on the WhyGuard host to analyze`,
    "this repository, or run the CLI locally instead: `npx whyguard init`.",
  ].join("\n");

  const checkRun = await publishCheckRun(client, {
    owner,
    repo,
    headSha: prRefs.headSha,
    conclusion: "neutral",
    title: "WhyGuard / Historical Decision Check",
    summary,
    text,
    annotations: [],
  });

  const report: ScanReport = {
    schemaVersion: 1,
    run: {
      id: `run_skipped_${prRefs.headSha.slice(0, 12)}`,
      repository: { provider: "github", owner, name: repo },
      baseSha: prRefs.baseSha,
      headSha: prRefs.headSha,
      source: "github",
      status: "failed",
      createdAt: now(),
    },
    findings: [],
    llmEnabled: false,
  };

  return { report: parseScanReport(report), checkRun, decisions: [] };
}

export async function scanPullRequest(input: ScanPullRequestInput): Promise<ScanPullRequestResult> {
  const { client, owner, repo, pullNumber, cloneUrl } = input;
  const now = input.now ?? (() => new Date().toISOString());
  const tempRoot = input.tempRoot ?? tmpdir();

  const prRefs = await getPullRequestRefs(client, { owner, repo, number: pullNumber });

  // Decide affordability before touching the disk. `baseRepoSizeKb` came free with the
  // request above, so this costs nothing and turns a disk-full crash partway through a
  // clone into an explicit, readable refusal on the PR itself.
  const sizeLimitKb = input.maxRepositorySizeKb ?? DEFAULT_MAX_REPOSITORY_SIZE_KB;
  if (sizeLimitKb > 0 && prRefs.baseRepoSizeKb > sizeLimitKb) {
    return skipOversizedRepository({
      client,
      owner,
      repo,
      prRefs,
      sizeLimitKb,
      now,
    });
  }

  // mkdtempSync only creates the final path segment — it fails with ENOENT if
  // tempRoot itself (e.g. a configured WHYGUARD_TEMP_ROOT like ".tmp/whyguard")
  // doesn't exist yet. Ensure the parent directory exists first.
  mkdirSync(tempRoot, { recursive: true });
  const workspace = mkdtempSync(join(tempRoot, "whyguard-pr-"));
  try {
    cloneRepository(cloneUrl, workspace);
    fetchRefspec(workspace, pullRequestHeadRefspec(pullNumber));

    const baseSha = resolveRef(workspace, prRefs.baseSha);
    const headSha = resolveRef(workspace, prRefs.headSha);

    const report = scanDiff({
      repoRoot: workspace,
      base: baseSha,
      head: headSha,
      source: "github",
      // Record the GitHub repository, not the ephemeral clone directory. `root` is
      // deliberately omitted: the workspace is deleted moments later, and persisting
      // an absolute server path would leak the filesystem layout through the public
      // read API.
      repository: { provider: "github", owner, name: repo },
      now,
    });
    // Read while the clone still exists — `.whyguard/decisions/*.yml` lives in
    // the repository being scanned, not in WhyGuard's own repo.
    const { contracts: decisions, invalid: invalidDecisions } =
      loadActiveContractsWithDiagnostics(workspace);

    const { summary, text } = formatCheckRunSummary(report.findings);
    const checkRun = await publishCheckRun(client, {
      owner,
      repo,
      headSha: prRefs.headSha,
      conclusion: severityToConclusion(report.findings),
      title: "WhyGuard / Historical Decision Check",
      summary,
      text: text + formatInvalidDecisionsNote(invalidDecisions),
      annotations: report.findings.map(findingToAnnotation),
    });

    return { report, checkRun, decisions };
  } finally {
    // "Delete repository workspace in `finally` blocks and
    // scheduled cleanup." Best-effort — a failed cleanup must not mask the
    // original result/error.
    rmSync(workspace, { recursive: true, force: true });
  }
}
