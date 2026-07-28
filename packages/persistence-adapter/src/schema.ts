/**
 * SQLite schema for WhyGuard's persistence layer and Phase 5 (dashboard) scope.
 *
 * Design notes:
 * - Every table stores WhyGuard's own domain IDs (Finding.id, AnalysisRun.id,
 *   RationaleContract.id) as TEXT primary keys — they are already unique and
 *   stable, so there is no reason to introduce a separate surrogate key.
 * - `findings.evidence_json` and `findings.protected_properties_json` store the
 *   full validated arrays as JSON. They are already Zod-validated by
 *   `@whyguard/contracts` before being written here — this layer is a durable
 *   store, not a second validation boundary. Read paths re-parse with
 *   `JSON.parse` and trust the shape, since only `saveScanReport` ever writes it.
 * - Decisions (rationale contracts) are persisted as a read-through cache of
 *   `.whyguard/decisions/*.yml` so the dashboard can list/filter them without
 *   re-reading the filesystem on every request; the YAML files remain the
 *   source of truth (`upsertDecision` is called after loading them).
 */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS repositories (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  owner TEXT,
  name TEXT NOT NULL,
  root TEXT,
  UNIQUE (provider, owner, name)
);

CREATE TABLE IF NOT EXISTS analysis_runs (
  id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL REFERENCES repositories(id),
  base_sha TEXT NOT NULL,
  head_sha TEXT NOT NULL,
  source TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  llm_enabled INTEGER NOT NULL DEFAULT 0,
  pull_request_number INTEGER,
  check_run_url TEXT
);

CREATE INDEX IF NOT EXISTS idx_analysis_runs_repository_created
  ON analysis_runs (repository_id, created_at DESC);

CREATE TABLE IF NOT EXISTS findings (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES analysis_runs(id),
  file_path TEXT NOT NULL,
  symbol TEXT,
  change_kind TEXT NOT NULL,
  severity TEXT NOT NULL,
  risk_score INTEGER NOT NULL,
  confidence_score INTEGER NOT NULL,
  reason_status TEXT NOT NULL,
  explanation TEXT NOT NULL,
  recommendation TEXT NOT NULL,
  -- Deliberately not a foreign key: a Finding's matched decision id comes from
  -- protectedProperties expanded at scan time (see finding-builder.ts), which is
  -- a separate write path from upsertDecision's read-through cache of
  -- .whyguard/decisions/*.yml. A finding can reference a decision id before (or
  -- even if never) that decision gets cached here.
  matching_decision_id TEXT,
  regression_test_status TEXT NOT NULL DEFAULT 'missing',
  evidence_json TEXT NOT NULL,
  protected_properties_json TEXT NOT NULL,
  change_json TEXT NOT NULL,
  -- Nullable: populated after saveScanReport by updateFindingLlmExplanation
  -- (written by the LLM explanation step; null when the fallback was used).
  -- A finding with no explanation yet (or whose caller has WHYGUARD_LLM_ENABLED
  -- unset and never called explainFinding at all) simply has NULL here — the
  -- read paths must treat that the same as "not computed", not as an error.
  llm_explanation_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_findings_run ON findings (run_id);
CREATE INDEX IF NOT EXISTS idx_findings_decision ON findings (matching_decision_id);

CREATE TABLE IF NOT EXISTS decisions (
  id TEXT PRIMARY KEY,
  version INTEGER NOT NULL,
  status TEXT NOT NULL,
  reason TEXT NOT NULL,
  owners_json TEXT NOT NULL,
  scope_json TEXT NOT NULL,
  must_preserve_json TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  required_tests_json TEXT NOT NULL,
  source_path TEXT,
  updated_at TEXT NOT NULL
);
`;

/**
 * Additive column migrations for databases created before this column existed.
 * `CREATE TABLE IF NOT EXISTS` above only creates the table on a brand-new
 * database — it does nothing to a `findings` table that already exists without
 * `llm_explanation_json`. SQLite has no `ADD COLUMN IF NOT EXISTS`, so this
 * checks `pragma_table_info` first and only runs `ALTER TABLE` when the column
 * is actually missing, keeping `migrate` safe to call on every `openDatabase`.
 */
const COLUMN_MIGRATIONS: { table: string; column: string; ddl: string }[] = [
  {
    table: "findings",
    column: "llm_explanation_json",
    ddl: "ALTER TABLE findings ADD COLUMN llm_explanation_json TEXT",
  },
];

/** Applies the schema to an already-open database handle. Idempotent (IF NOT EXISTS everywhere). */
export function migrate(
  exec: (sql: string) => void,
  hasColumn: (table: string, column: string) => boolean,
): void {
  exec(SCHEMA_SQL);
  for (const migration of COLUMN_MIGRATIONS) {
    if (!hasColumn(migration.table, migration.column)) {
      exec(migration.ddl);
    }
  }
}
