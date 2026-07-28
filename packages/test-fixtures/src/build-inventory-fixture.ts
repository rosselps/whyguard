import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { git, gitInit } from "./fixture-git.js";
import {
  INVENTORY_SYNC_DECISION,
  SAFE_SYNC_INVENTORY,
  UNSAFE_SYNC_INVENTORY,
} from "./inventory-sync-versions.js";

/** Repo-relative path of the file this fixture's protected behavior lives in. */
export const INVENTORY_FIXTURE_FILE = join("src", "logistics", "sync-inventory.ts");

/** Repo-relative path of the rationale contract the demo writes in its final step. */
export const INVENTORY_FIXTURE_DECISION_FILE = join(
  ".whyguard",
  "decisions",
  "inventory-sync-resilience.yml",
);

/** Repo-relative path of the regression test the contract declares. */
export const INVENTORY_FIXTURE_TEST_FILE = join("tests", "logistics", "sync-inventory.test.ts");

export type InventoryFixtureResult = {
  repoRoot: string;
  safeSha: string;
  unsafeSha: string;
};

/**
 * Builds a throwaway repository for the "timeouts" scenario:
 *
 *   commit 1 ("safe"):   syncInventory retries 3 times with a 30s timeout. The commit
 *                        message references the incident (`fixes #212`, `PR #219`).
 *   commit 2 ("unsafe"): timeout cut to 3s, retries cut to 1, retry wrapper deleted.
 *
 * Ships **no** `.whyguard/decisions/` entry, which is the entire point: WhyGuard detects
 * and explains the change from Git history alone but stops short of blocking, because
 * nothing states that the behavior must be preserved. The demo then writes the contract
 * and re-scans so the same code becomes a block.
 */
export function buildInventoryFixture(targetDir?: string): InventoryFixtureResult {
  const repoRoot = resolve(targetDir ?? join(process.cwd(), ".tmp", "whyguard-inventory-fixture"));

  if (existsSync(repoRoot)) {
    rmSync(repoRoot, { recursive: true, force: true });
  }
  mkdirSync(repoRoot, { recursive: true });

  gitInit(repoRoot);

  const filePath = join(repoRoot, INVENTORY_FIXTURE_FILE);
  mkdirSync(join(repoRoot, "src", "logistics"), { recursive: true });

  writeFileSync(filePath, SAFE_SYNC_INVENTORY, "utf-8");
  git(repoRoot, ["add", "."]);
  git(repoRoot, [
    "commit",
    "-m",
    "Retry warehouse inventory sync with a 30s timeout (fixes #212)\n\n" +
      "The provider returns 504 under load, which silently dropped batches and\n" +
      "left stock counts drifting. Closes #212. See PR #219.",
  ]);
  const safeSha = git(repoRoot, ["rev-parse", "HEAD"]);

  writeFileSync(filePath, UNSAFE_SYNC_INVENTORY, "utf-8");
  git(repoRoot, ["add", "."]);
  git(repoRoot, ["commit", "-m", "Speed up inventory sync by trimming retries and timeout"]);
  const unsafeSha = git(repoRoot, ["rev-parse", "HEAD"]);

  return { repoRoot, safeSha, unsafeSha };
}

/**
 * Writes the rationale contract without committing it.
 *
 * Contracts are read from the working tree, not from a ref, so this alone flips the same
 * `safeSha..unsafeSha` comparison from warn to block. Staying untracked also means it
 * survives the `reset --hard` in `stageInventoryWeakeningInWorkingTree`, which is what
 * lets one repository carry all three phases of the demo.
 *
 * Returns the absolute path written.
 */
export function writeInventoryDecision(repoRoot: string): string {
  const decisionPath = join(repoRoot, INVENTORY_FIXTURE_DECISION_FILE);
  mkdirSync(join(repoRoot, ".whyguard", "decisions"), { recursive: true });
  writeFileSync(decisionPath, INVENTORY_SYNC_DECISION, "utf-8");
  return decisionPath;
}

/**
 * Puts the repository into the state the enforcement layers act on: `HEAD` holds the
 * safe code plus the recorded decision, and the weakening edit sits uncommitted in the
 * working tree.
 *
 * The decision is committed here rather than left untracked so that a subsequent
 * `git add -A` stages only the code change under review. A commit that mixed "the
 * decision" and "the change that violates it" together would let the reader think
 * WhyGuard was reacting to its own contract file.
 */
export function stageInventoryWeakeningInWorkingTree(repoRoot: string, safeSha: string): string {
  git(repoRoot, ["reset", "--hard", safeSha]);

  if (existsSync(join(repoRoot, ".whyguard"))) {
    git(repoRoot, ["add", ".whyguard"]);
    git(repoRoot, [
      "commit",
      "-m",
      "Record the inventory sync resilience decision\n\n" +
        "Why #212 mattered, written down so it survives the next refactor.",
    ]);
  }

  const filePath = join(repoRoot, INVENTORY_FIXTURE_FILE);
  writeFileSync(filePath, UNSAFE_SYNC_INVENTORY, "utf-8");
  return filePath;
}
