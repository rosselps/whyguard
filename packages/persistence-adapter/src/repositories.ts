import type { RepositoryRef } from "@whyguard/contracts";
import type { WhyGuardDatabase } from "./database.js";

/**
 * Deterministic, stable ID for a repository row, derived from its identity
 * fields rather than an auto-increment — so `upsertRepository` is idempotent
 * across process restarts (unlike an AUTOINCREMENT id, which would differ every
 * time the same repository is first seen in a fresh database).
 */
export function repositoryId(ref: RepositoryRef): string {
  const owner = ref.owner ?? "-";
  return `repo_${ref.provider}_${owner}_${ref.name}`.replace(/[^a-zA-Z0-9_.-]/g, "_");
}

export type RepositoryRow = {
  id: string;
  provider: string;
  owner: string | null;
  name: string;
  root: string | null;
};

/** Inserts a repository row if it doesn't exist yet; returns its stable id either way. */
export function upsertRepository(db: WhyGuardDatabase, ref: RepositoryRef): string {
  const id = repositoryId(ref);
  db.prepare(
    `INSERT INTO repositories (id, provider, owner, name, root)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET root = excluded.root`,
  ).run(id, ref.provider, ref.owner ?? null, ref.name, ref.root ?? null);
  return id;
}

/** Lists every known repository, most recently active first (by latest analysis run). */
export function listRepositories(db: WhyGuardDatabase): RepositoryRow[] {
  const rows = db
    .prepare(
      `SELECT r.id, r.provider, r.owner, r.name, r.root
       FROM repositories r
       LEFT JOIN (
         SELECT repository_id, MAX(created_at) AS last_run_at
         FROM analysis_runs
         GROUP BY repository_id
       ) latest ON latest.repository_id = r.id
       ORDER BY latest.last_run_at DESC NULLS LAST, r.name ASC`,
    )
    .all();
  return rows as RepositoryRow[];
}
