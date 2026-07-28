import type { RationaleContract } from "@whyguard/contracts";
import type { WhyGuardDatabase } from "./database.js";

/**
 * Persists rationale contracts (`.whyguard/decisions/*.yml`) as a read-through
 * cache, per the note in `schema.ts`. The YAML files on disk remain the source of
 * truth — callers are expected to call `upsertDecision` after loading/validating
 * a contract (e.g. right after `loadActiveContracts`/`registerDecision`), not
 * treat this table as something to write to directly from the dashboard.
 */
export type DecisionRow = {
  id: string;
  version: number;
  status: RationaleContract["status"];
  reason: string;
  owners: string[];
  scope: RationaleContract["scope"];
  mustPreserve: string[];
  evidence: RationaleContract["evidence"];
  requiredTests: string[];
  sourcePath: string | null;
  updatedAt: string;
};

type DecisionSqlRow = {
  id: string;
  version: number;
  status: string;
  reason: string;
  owners_json: string;
  scope_json: string;
  must_preserve_json: string;
  evidence_json: string;
  required_tests_json: string;
  source_path: string | null;
  updated_at: string;
};

function toDecisionRow(row: DecisionSqlRow): DecisionRow {
  return {
    id: row.id,
    version: row.version,
    status: row.status as RationaleContract["status"],
    reason: row.reason,
    owners: JSON.parse(row.owners_json) as string[],
    scope: JSON.parse(row.scope_json) as RationaleContract["scope"],
    mustPreserve: JSON.parse(row.must_preserve_json) as string[],
    evidence: JSON.parse(row.evidence_json) as RationaleContract["evidence"],
    requiredTests: JSON.parse(row.required_tests_json) as string[],
    sourcePath: row.source_path,
    updatedAt: row.updated_at,
  };
}

export type UpsertDecisionInput = {
  contract: RationaleContract;
  sourcePath?: string;
  now?: () => string;
};

/** Inserts or replaces a decision row from a validated RationaleContract. */
export function upsertDecision(db: WhyGuardDatabase, input: UpsertDecisionInput): void {
  const { contract } = input;
  const now = input.now ?? (() => new Date().toISOString());

  db.prepare(
    `INSERT INTO decisions (
       id, version, status, reason, owners_json, scope_json,
       must_preserve_json, evidence_json, required_tests_json, source_path, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       version = excluded.version,
       status = excluded.status,
       reason = excluded.reason,
       owners_json = excluded.owners_json,
       scope_json = excluded.scope_json,
       must_preserve_json = excluded.must_preserve_json,
       evidence_json = excluded.evidence_json,
       required_tests_json = excluded.required_tests_json,
       source_path = excluded.source_path,
       updated_at = excluded.updated_at`,
  ).run(
    contract.id,
    contract.version,
    contract.status,
    contract.reason,
    JSON.stringify(contract.owners),
    JSON.stringify(contract.scope),
    JSON.stringify(contract.must_preserve),
    JSON.stringify(contract.evidence),
    JSON.stringify(contract.required_tests),
    input.sourcePath ?? null,
    now(),
  );
}

/** Fetches a single decision by id, or undefined if it has never been cached. */
export function getDecision(db: WhyGuardDatabase, id: string): DecisionRow | undefined {
  const row = db.prepare(`SELECT * FROM decisions WHERE id = ?`).get(id) as
    DecisionSqlRow | undefined;
  return row ? toDecisionRow(row) : undefined;
}

/** Lists every cached decision, most recently updated first. */
export function listDecisions(db: WhyGuardDatabase): DecisionRow[] {
  const rows = db
    .prepare(`SELECT * FROM decisions ORDER BY updated_at DESC`)
    .all() as DecisionSqlRow[];
  return rows.map(toDecisionRow);
}
