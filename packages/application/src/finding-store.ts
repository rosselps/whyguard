import type { Finding } from "@whyguard/contracts";

/**
 * In-memory Finding store, used to back `whyguard.get_finding` (per
 * 's MCP tool table).
 *
 * `scanDiff` and `guardChange` are pure functions — they compute and return Findings
 * but do not persist them. A caller that wants `get_finding` to work must record them
 * here right after computing them, within the same process.
 *
 * This store is intentionally process-local and non-durable: restarting clears it.
 * Durable lookup is a separate concern owned by `@whyguard/persistence-adapter`
 * (`getPersistedFinding`), and the MCP server checks this store first, then the
 * database — so a finding id from a GitHub Pull Request analysis still resolves.
 *
 * That layering must not be papered over: `getFinding` returns `undefined` for
 * anything not recorded in the current process, never a fabricated result.
 */

const findingsById = new Map<string, Finding>();

/** Records a single Finding so it can later be retrieved by `getFinding`. */
export function recordFinding(finding: Finding): void {
  findingsById.set(finding.id, finding);
}

/** Records every Finding in a list. Convenience wrapper around `recordFinding`. */
export function recordFindings(findings: Finding[]): void {
  for (const finding of findings) recordFinding(finding);
}

/** Looks up a previously recorded Finding by id. Returns `undefined` if unknown. */
export function getFinding(id: string): Finding | undefined {
  return findingsById.get(id);
}

/** Returns every Finding recorded so far, most-recently-recorded order not guaranteed. */
export function listFindings(): Finding[] {
  return [...findingsById.values()];
}

/** Clears the store. Exposed for tests only. */
export function resetFindingStoreForTests(): void {
  findingsById.clear();
}
