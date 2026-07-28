import { execFileSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  buildPaymentFixture,
  SAFE_CREATE_ORDER,
  UNSAFE_CREATE_ORDER,
} from "@whyguard/test-fixtures";
import { resetGuardChangeCountersForTests } from "./guard-change.js";
import { verifyUncommittedWork } from "./verify-uncommitted-work.js";

/**
 * Tests for `whyguard verify`, the enforcement layer behind the PreToolUse hook
 * (). Covers both intended callers: the Kiro
 * `Stop` hook (`working-tree` scope) and the Git `pre-commit` hook (`staged` scope).
 */
describe("verifyUncommittedWork", () => {
  const fixtureDir = join(process.cwd(), ".tmp", "whyguard-verify-test");
  const targetFile = "src/payments/create-order.ts";

  /**
   * Pinned to the fixture repository the same way `buildPaymentFixture` pins its own
   * Git calls: without `GIT_DIR`/`GIT_WORK_TREE`, Git walks up and would operate on
   * the enclosing WhyGuard repository if the fixture's `.git` were missing. A
   * `git reset --hard` escaping to the real repo would destroy uncommitted work.
   */
  function git(repoRoot: string, args: string[]): void {
    execFileSync("git", ["-c", "core.hooksPath=", ...args], {
      cwd: repoRoot,
      encoding: "utf-8",
      env: {
        ...process.env,
        GIT_DIR: join(repoRoot, ".git"),
        GIT_WORK_TREE: repoRoot,
        GIT_CEILING_DIRECTORIES: dirname(repoRoot),
      },
    });
  }

  /**
   * Builds a fixture whose HEAD contains the idempotency guard, leaving the
   * uncommitted state free for each test to set up. `buildPaymentFixture` commits
   * the guard removal as its second commit, so resetting to the safe SHA is what
   * puts the *protected* version at HEAD.
   */
  function fixtureAtSafeHead(name: string): string {
    const { repoRoot, safeSha } = buildPaymentFixture(join(fixtureDir, name));
    git(repoRoot, ["reset", "--hard", safeSha]);
    return repoRoot;
  }

  beforeEach(() => {
    resetGuardChangeCountersForTests();
  });

  afterAll(() => {
    rmSync(fixtureDir, { recursive: true, force: true });
  });

  it("blocks an uncommitted guard removal left behind by an agent (Stop-hook scope)", () => {
    const repoRoot = fixtureAtSafeHead("stop-hook-block");
    // Simulates exactly what the two models did after ignoring the PreToolUse
    // block: the guard is gone from the checkout, nothing is committed yet.
    writeFileSync(join(repoRoot, targetFile), UNSAFE_CREATE_ORDER, "utf-8");

    const result = verifyUncommittedWork({ repoRoot, scope: "working-tree" });

    expect(result.decision).toBe("block");
    expect(result.analyzedFilePaths).toContain(targetFile);
    expect(result.report).toContain("WHYGUARD BLOCKED THIS COMMIT");
    expect(result.report).toContain("One idempotency key creates at most one order.");
  });

  it("allows a clean checkout with nothing uncommitted", () => {
    const repoRoot = fixtureAtSafeHead("clean");

    const result = verifyUncommittedWork({ repoRoot, scope: "working-tree" });

    expect(result.decision).toBe("allow");
    expect(result.analyzedFilePaths).toHaveLength(0);
    expect(result.report).toContain("no historical-decision risk");
  });

  it("allows an uncommitted change that preserves the protected behavior", () => {
    const repoRoot = fixtureAtSafeHead("safe-edit");
    // A real edit that keeps the guard intact: append an unrelated helper.
    writeFileSync(
      join(repoRoot, targetFile),
      `${SAFE_CREATE_ORDER}\nexport function orderCount(): number {\n  return existingOrders.size;\n}\n`,
      "utf-8",
    );

    const result = verifyUncommittedWork({ repoRoot, scope: "working-tree" });

    expect(result.decision).toBe("allow");
    expect(result.analyzedFilePaths).toContain(targetFile);
  });

  it("blocks a staged guard removal (pre-commit scope)", () => {
    const repoRoot = fixtureAtSafeHead("pre-commit-block");
    writeFileSync(join(repoRoot, targetFile), UNSAFE_CREATE_ORDER, "utf-8");
    git(repoRoot, ["add", targetFile]);

    const result = verifyUncommittedWork({ repoRoot, scope: "staged" });

    expect(result.decision).toBe("block");
    expect(result.report).toContain("staged changes");
  });

  it("blocks a staged removal even when the working-tree file was restored afterwards", () => {
    // The reason `staged` scope reads the index (`git show:<path>`) instead of the
    // file on disk: staging a removal and then quietly restoring the file on disk
    // would otherwise hide the removal that `git commit` is actually about to
    // record.
    const repoRoot = fixtureAtSafeHead("staged-vs-worktree");
    writeFileSync(join(repoRoot, targetFile), UNSAFE_CREATE_ORDER, "utf-8");
    git(repoRoot, ["add", targetFile]);
    writeFileSync(join(repoRoot, targetFile), SAFE_CREATE_ORDER, "utf-8");

    const staged = verifyUncommittedWork({ repoRoot, scope: "staged" });
    expect(staged.decision).toBe("block");

    // Working-tree scope compares HEAD against the restored file, which is
    // identical to HEAD, so it legitimately reports nothing.
    resetGuardChangeCountersForTests();
    const workingTree = verifyUncommittedWork({ repoRoot, scope: "working-tree" });
    expect(workingTree.decision).toBe("allow");
  });

  it("ignores files outside the TS/JS MVP detector scope", () => {
    const repoRoot = fixtureAtSafeHead("non-ts");
    writeFileSync(join(repoRoot, "README.md"), "# notes\n", "utf-8");
    git(repoRoot, ["add", "README.md"]);

    const result = verifyUncommittedWork({ repoRoot, scope: "staged" });

    expect(result.analyzedFilePaths).toHaveLength(0);
    expect(result.decision).toBe("allow");
  });
});
