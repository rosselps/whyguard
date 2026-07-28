import type {
  Evidence,
  Finding,
  LlmExplanation,
  ProtectedProperty,
  ScanReport,
  SensitiveChange,
} from "@whyguard/contracts";
import { FindingSchema } from "@whyguard/contracts";
import type { WhyGuardDatabase } from "./database.js";
import { upsertRepository } from "./repositories.js";

/**
 * Persists a completed `ScanReport` (the output of `scanDiff`/`scanPullRequest`)
 * and every `Finding` it contains. This is the write path both `apps/api`
 * (GitHub PR scans) and `apps/cli` (`whyguard scan`) call after a scan completes
 * —, CLI-generated reports are
 * persisted the same way GitHub-triggered ones are, so the dashboard shows both.
 *
 * Idempotent: re-saving a report with the same `run.id` replaces its findings
 * (`ON CONFLICT` on the run row, delete+reinsert on findings) rather than
 * duplicating them, so retried scans don't produce duplicate dashboard rows.
 */
export type SaveScanReportOptions = {
  pullRequestNumber?: number;
  checkRunUrl?: string;
};

export function saveScanReport(
  db: WhyGuardDatabase,
  report: ScanReport,
  options: SaveScanReportOptions = {},
): void {
  const repositoryId = upsertRepository(db, report.run.repository);

  db.prepare(
    `INSERT INTO analysis_runs (
       id, repository_id, base_sha, head_sha, source, status, created_at,
       llm_enabled, pull_request_number, check_run_url
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       status = excluded.status,
       llm_enabled = excluded.llm_enabled,
       pull_request_number = excluded.pull_request_number,
       check_run_url = excluded.check_run_url`,
  ).run(
    report.run.id,
    repositoryId,
    report.run.baseSha,
    report.run.headSha,
    report.run.source,
    report.run.status,
    report.run.createdAt,
    report.llmEnabled ? 1 : 0,
    options.pullRequestNumber ?? null,
    options.checkRunUrl ?? null,
  );

  db.prepare(`DELETE FROM findings WHERE run_id = ?`).run(report.run.id);

  const insertFinding = db.prepare(
    `INSERT INTO findings (
       id, run_id, file_path, symbol, change_kind, severity, risk_score,
       confidence_score, reason_status, explanation, recommendation,
       matching_decision_id, regression_test_status, evidence_json,
       protected_properties_json, change_json
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  for (const finding of report.findings) {
    insertFinding.run(
      finding.id,
      finding.runId,
      finding.change.filePath,
      finding.change.symbol ?? null,
      finding.change.kind,
      finding.severity,
      finding.riskScore,
      finding.confidenceScore,
      finding.reasonStatus,
      finding.explanation,
      finding.recommendation,
      matchingDecisionIdFor(finding),
      finding.regressionTest?.framework ? "suggested" : "missing",
      JSON.stringify(finding.evidence),
      JSON.stringify(finding.protectedProperties),
      JSON.stringify(finding.change),
    );
  }
}

/**
 * A Finding does not carry the matched decision's id directly — it carries the
 * decision's `must_preserve` statements already expanded into
 * `protectedProperties` with `status: "confirmed"` and ids shaped
 * `pp_decision_<contractId>_<index>` (see `finding-builder.ts`'s
 * `contractToProtectedProperties`). Extracting the contract id from that id shape
 * is the only place this coupling exists, and it is read-only (never re-derives
 * or mutates the id) — if that id format ever changes, this is the one place to
 * update.
 */
function matchingDecisionIdFor(finding: Finding): string | null {
  const confirmed = finding.protectedProperties.find(
    (property) => property.status === "confirmed" && property.id.startsWith("pp_decision_"),
  );
  if (!confirmed) return null;
  const withoutPrefix = confirmed.id.slice("pp_decision_".length);
  const lastUnderscore = withoutPrefix.lastIndexOf("_");
  return lastUnderscore === -1 ? withoutPrefix : withoutPrefix.slice(0, lastUnderscore);
}

export type AnalysisRunRow = {
  id: string;
  repositoryId: string;
  repositoryName: string;
  baseSha: string;
  headSha: string;
  source: string;
  status: string;
  createdAt: string;
  llmEnabled: boolean;
  pullRequestNumber: number | null;
  checkRunUrl: string | null;
  findingCount: number;
  highestSeverity: string | null;
};

type AnalysisRunSqlRow = {
  id: string;
  repository_id: string;
  repository_name: string;
  base_sha: string;
  head_sha: string;
  source: string;
  status: string;
  created_at: string;
  llm_enabled: number;
  pull_request_number: number | null;
  check_run_url: string | null;
  finding_count: number;
  highest_severity: string | null;
};

const SEVERITY_RANK =
  "CASE severity " +
  "WHEN 'critical' THEN 4 WHEN 'high' THEN 3 WHEN 'medium' THEN 2 WHEN 'low' THEN 1 ELSE 0 END";

function toAnalysisRunRow(row: AnalysisRunSqlRow): AnalysisRunRow {
  return {
    id: row.id,
    repositoryId: row.repository_id,
    repositoryName: row.repository_name,
    baseSha: row.base_sha,
    headSha: row.head_sha,
    source: row.source,
    status: row.status,
    createdAt: row.created_at,
    llmEnabled: row.llm_enabled === 1,
    pullRequestNumber: row.pull_request_number,
    checkRunUrl: row.check_run_url,
    findingCount: row.finding_count,
    highestSeverity: row.highest_severity,
  };
}

/** Lists analysis runs (most recent first), each annotated with its finding count and top severity. */
export function listAnalysisRuns(db: WhyGuardDatabase, limit = 50): AnalysisRunRow[] {
  const rows = db
    .prepare(
      `SELECT
         ar.id, ar.repository_id, r.name AS repository_name, ar.base_sha, ar.head_sha,
         ar.source, ar.status, ar.created_at, ar.llm_enabled,
         ar.pull_request_number, ar.check_run_url,
         COUNT(f.id) AS finding_count,
         (SELECT f2.severity FROM findings f2 WHERE f2.run_id = ar.id
            ORDER BY ${SEVERITY_RANK.replace("severity", "f2.severity")} DESC LIMIT 1) AS highest_severity
       FROM analysis_runs ar
       JOIN repositories r ON r.id = ar.repository_id
       LEFT JOIN findings f ON f.run_id = ar.id
       GROUP BY ar.id
       ORDER BY ar.created_at DESC
       LIMIT ?`,
    )
    .all(limit) as AnalysisRunSqlRow[];
  return rows.map(toAnalysisRunRow);
}

export type FindingRow = {
  id: string;
  runId: string;
  change: SensitiveChange;
  severity: string;
  riskScore: number;
  confidenceScore: number;
  reasonStatus: string;
  explanation: string;
  recommendation: string;
  matchingDecisionId: string | null;
  regressionTestStatus: string;
  evidence: Evidence[];
  protectedProperties: ProtectedProperty[];
  /** `null` until `updateFindingLlmExplanation` has been called for this finding. */
  llmExplanation: LlmExplanation | null;
};

type FindingSqlRow = {
  id: string;
  run_id: string;
  change_json: string;
  severity: string;
  risk_score: number;
  confidence_score: number;
  reason_status: string;
  explanation: string;
  recommendation: string;
  matching_decision_id: string | null;
  regression_test_status: string;
  evidence_json: string;
  protected_properties_json: string;
  llm_explanation_json: string | null;
};

function toFindingRow(row: FindingSqlRow): FindingRow {
  return {
    id: row.id,
    runId: row.run_id,
    change: JSON.parse(row.change_json) as SensitiveChange,
    severity: row.severity,
    riskScore: row.risk_score,
    confidenceScore: row.confidence_score,
    reasonStatus: row.reason_status,
    explanation: row.explanation,
    recommendation: row.recommendation,
    matchingDecisionId: row.matching_decision_id,
    regressionTestStatus: row.regression_test_status,
    evidence: JSON.parse(row.evidence_json) as Evidence[],
    protectedProperties: JSON.parse(row.protected_properties_json) as ProtectedProperty[],
    llmExplanation: row.llm_explanation_json
      ? (JSON.parse(row.llm_explanation_json) as LlmExplanation)
      : null,
  };
}

/**
 * Persists the LLM explanation computed for a specific finding (see
 * `@whyguard/llm-adapter`'s `explainFinding`), after `saveScanReport` has
 * already written the finding row. Kept as its own write path rather than a
 * parameter on `saveScanReport` — `persistence-adapter` never depends on
 * `llm-adapter` (no package should import the LLM layer except the apps that
 * orchestrate the scan), so the caller (an app) computes the explanation and
 * hands back only the already-validated `LlmExplanation` value.
 */
export function updateFindingLlmExplanation(
  db: WhyGuardDatabase,
  findingId: string,
  explanation: LlmExplanation,
): void {
  db.prepare(`UPDATE findings SET llm_explanation_json = ? WHERE id = ?`).run(
    JSON.stringify(explanation),
    findingId,
  );
}

/** Fetches a single finding by id, or undefined if it doesn't exist. */
export function getFindingById(db: WhyGuardDatabase, findingId: string): FindingRow | undefined {
  const row = db.prepare(`SELECT * FROM findings WHERE id = ?`).get(findingId) as
    FindingSqlRow | undefined;
  return row ? toFindingRow(row) : undefined;
}

/**
 * Fetches a single finding by id and rebuilds it as a schema-valid `Finding`.
 *
 * `getFindingById` returns the storage-shaped `FindingRow` (with the persisted
 * `llmExplanation` the dashboard needs). This variant returns the domain type
 * instead, so consumers that speak `Finding` — the MCP server's
 * `whyguard.get_finding` and `whyguard.propose_regression_test` in particular —
 * can serve findings produced by an *earlier* process (a GitHub PR analysis, a
 * previous CLI run) rather than only those computed in their own memory.
 *
 * The result is validated with `FindingSchema` before being returned: a row written
 * by an older schema version must fail loudly here rather than surface as a
 * half-populated Finding to an agent.
 */
export function getPersistedFinding(db: WhyGuardDatabase, findingId: string): Finding | undefined {
  const row = getFindingById(db, findingId);
  if (!row) return undefined;

  return FindingSchema.parse({
    id: row.id,
    runId: row.runId,
    change: row.change,
    evidenceIds: row.evidence.map((item) => item.id),
    evidence: row.evidence,
    protectedProperties: row.protectedProperties,
    riskScore: row.riskScore,
    confidenceScore: row.confidenceScore,
    severity: row.severity,
    reasonStatus: row.reasonStatus,
    explanation: row.explanation,
    recommendation: row.recommendation,
  });
}

export type SummaryCounts = {
  totalAnalyses: number;
  /** Human-confirmed rationale contracts currently in force. */
  activeDecisions: number;
  /** Findings at `high` or `critical` severity, across every analysis. */
  highRiskFindings: number;
  /** Findings with no regression test proving the protected behavior. */
  findingsWithoutTest: number;
  /**
   * Findings where no reliable historical reason was found. Surfaced deliberately
   * rather than hidden: UI principle is "Show 'unknown' explicitly
   * instead of hiding weak evidence".
   */
  unknownReasonFindings: number;
};

/**
 * Aggregate counts for the dashboard's overview screen.
 *
 * Computed in SQL rather than by fetching every row and counting in the client: the
 * dashboard only needs five numbers, and paging the entire findings table to the browser
 * to derive them would get slower with every analysis.
 */
export function getSummaryCounts(db: WhyGuardDatabase): SummaryCounts {
  const one = (sql: string): number => {
    const row = db.prepare(sql).get() as { value: number } | undefined;
    return row?.value ?? 0;
  };

  return {
    totalAnalyses: one(`SELECT COUNT(*) AS value FROM analysis_runs`),
    activeDecisions: one(`SELECT COUNT(*) AS value FROM decisions WHERE status = 'active'`),
    highRiskFindings: one(
      `SELECT COUNT(*) AS value FROM findings WHERE severity IN ('high', 'critical')`,
    ),
    findingsWithoutTest: one(
      `SELECT COUNT(*) AS value FROM findings WHERE regression_test_status = 'missing'`,
    ),
    unknownReasonFindings: one(
      `SELECT COUNT(*) AS value FROM findings WHERE reason_status = 'unknown'`,
    ),
  };
}

/**
 * Timestamp of the most recent analysis that came from a GitHub webhook, or null if none
 * ever has. Used by the dashboard to distinguish "the GitHub App is configured" from
 * "the GitHub App has actually delivered something" — a distinction that matters, since
 * a broken tunnel or wrong webhook URL leaves credentials looking perfectly healthy.
 */
export function getLastGithubAnalysisAt(db: WhyGuardDatabase): string | null {
  const row = db
    .prepare(
      `SELECT created_at FROM analysis_runs WHERE source = 'github' ORDER BY created_at DESC LIMIT 1`,
    )
    .get() as { created_at: string } | undefined;
  return row?.created_at ?? null;
}

/** Fetches a single analysis run's metadata (or undefined if unknown). */
export function getAnalysisRun(db: WhyGuardDatabase, runId: string): AnalysisRunRow | undefined {
  const row = db
    .prepare(
      `SELECT
         ar.id, ar.repository_id, r.name AS repository_name, ar.base_sha, ar.head_sha,
         ar.source, ar.status, ar.created_at, ar.llm_enabled,
         ar.pull_request_number, ar.check_run_url,
         (SELECT COUNT(*) FROM findings f WHERE f.run_id = ar.id) AS finding_count,
         (SELECT f2.severity FROM findings f2 WHERE f2.run_id = ar.id
            ORDER BY ${SEVERITY_RANK.replace("severity", "f2.severity")} DESC LIMIT 1) AS highest_severity
       FROM analysis_runs ar
       JOIN repositories r ON r.id = ar.repository_id
       WHERE ar.id = ?`,
    )
    .get(runId) as AnalysisRunSqlRow | undefined;
  return row ? toAnalysisRunRow(row) : undefined;
}

/** Lists every finding for a given analysis run. */
export function listFindingsForRun(db: WhyGuardDatabase, runId: string): FindingRow[] {
  const rows = db
    .prepare(`SELECT * FROM findings WHERE run_id = ? ORDER BY risk_score DESC`)
    .all(runId) as FindingSqlRow[];
  return rows.map(toFindingRow);
}

/** Lists every finding that matched a given decision, across all analysis runs. */
export function listFindingsForDecision(db: WhyGuardDatabase, decisionId: string): FindingRow[] {
  const rows = db
    .prepare(`SELECT * FROM findings WHERE matching_decision_id = ? ORDER BY id DESC`)
    .all(decisionId) as FindingSqlRow[];
  return rows.map(toFindingRow);
}
