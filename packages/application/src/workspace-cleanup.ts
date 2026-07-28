import { readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Prefix every ephemeral PR workspace is created with (see `scanPullRequest`). Shared
 * here so the sweep below can only ever delete directories WhyGuard itself created —
 * it runs against a shared temp root, so matching anything broader would be reckless.
 */
export const PR_WORKSPACE_PREFIX = "whyguard-pr-";

/** Workspaces older than this are considered abandoned. */
const DEFAULT_MAX_AGE_MS = 60 * 60 * 1000;

export type SweepResult = {
  removed: string[];
  failed: { path: string; error: string }[];
};

/**
 * Deletes abandoned PR workspaces left under `tempRoot`.
 *
 * `scanPullRequest` removes its own workspace in a `finally` block, which covers every
 * outcome the process survives — not an OOM kill, a restart mid-scan, or a deploy that
 * replaces the instance. Each of those leaves a full clone behind, and a handful is
 * enough to fill a small disk, after which every scan fails with what looks like a Git
 * error rather than a capacity problem.
 *
 * Run once at startup. Narrow on purpose: only direct children of `tempRoot` matching
 * `PR_WORKSPACE_PREFIX`, only directories, only older than `maxAgeMs` (default one hour)
 * so a scan running in a parallel process is never pulled out from under it. Never
 * throws — a cleanup pass that crashes startup is worse than the garbage it collects.
 */
export function sweepStaleWorkspaces(
  tempRoot: string,
  options: { maxAgeMs?: number; now?: () => number } = {},
): SweepResult {
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const now = options.now ?? Date.now;
  const result: SweepResult = { removed: [], failed: [] };

  let entries: string[];
  try {
    entries = readdirSync(tempRoot);
  } catch {
    // No temp root yet (nothing has been scanned) is the normal case on a fresh box.
    return result;
  }

  for (const entry of entries) {
    if (!entry.startsWith(PR_WORKSPACE_PREFIX)) continue;
    const path = join(tempRoot, entry);

    try {
      const stats = statSync(path);
      if (!stats.isDirectory()) continue;
      if (now() - stats.mtimeMs < maxAgeMs) continue;
      rmSync(path, { recursive: true, force: true });
      result.removed.push(path);
    } catch (error) {
      result.failed.push({
        path,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return result;
}
