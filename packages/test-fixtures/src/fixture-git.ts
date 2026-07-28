import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

/** Git helpers shared by every fixture builder, so the pinning rules live in one place. */

/**
 * Runs Git strictly against the fixture repository, never the one containing it.
 *
 * Git discovers its repository by walking *up*, so if the fixture's `.git` is missing for
 * any reason it silently falls back to the enclosing project and `git add.` starts
 * committing real files. `GIT_DIR`/`GIT_WORK_TREE` remove the discovery,
 * `GIT_CEILING_DIRECTORIES` stops residual traversal, and an empty `core.hooksPath` keeps
 * an inherited hook from running against a throwaway repository.
 */
export function git(repoRoot: string, args: string[]): string {
  return execFileSync("git", ["-c", "core.hooksPath=", ...args], {
    cwd: repoRoot,
    encoding: "utf-8",
    // Captured, not inherited: otherwise Git's line-ending advice ("LF will be replaced
    // by CRLF") appears in the middle of the demo's own output on Windows.
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      GIT_DIR: join(repoRoot, ".git"),
      GIT_WORK_TREE: repoRoot,
      GIT_CEILING_DIRECTORIES: dirname(repoRoot),
    },
  }).trim();
}

/**
 * `git init` is the one call that must NOT have `GIT_DIR` pinned to a path that does
 * not exist yet, and it is also the call whose success everything else depends on.
 */
export function gitInit(repoRoot: string): void {
  execFileSync("git", ["-c", "core.hooksPath=", "init", "--initial-branch=main"], {
    cwd: repoRoot,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_CEILING_DIRECTORIES: dirname(repoRoot) },
  });

  if (!existsSync(join(repoRoot, ".git"))) {
    throw new Error(
      `git init did not create ${join(repoRoot, ".git")}. Refusing to continue: ` +
        "subsequent Git commands would silently target the enclosing repository.",
    );
  }

  git(repoRoot, ["config", "user.email", "demo@whyguard.local"]);
  git(repoRoot, ["config", "user.name", "WhyGuard Demo"]);
}
