import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { installGitPreCommitHook } from "./install-git-hook.js";

/**
 * Tests for the Git `pre-commit` installer — the one WhyGuard enforcement layer an
 * agent cannot bypass, since Git aborts the commit itself (see install-git-hook.ts).
 */
describe("installGitPreCommitHook", () => {
  const tempRoot = join(process.cwd(), ".tmp", "whyguard-install-hook-test");

  /**
   * A stand-in for the built CLI path, passed explicitly so these tests never depend on
   * `dist/` existing. Turbo's `test` task only dependsOn `^build` (dependencies'
   * builds), not the package's own, so reading the real entrypoint made these tests
   * fail intermittently in a full run while passing in isolation.
   */
  const FAKE_CLI = "C:/fake/whyguard/apps/cli/dist/index.js";

  function initRepo(name: string): string {
    const repoRoot = join(tempRoot, name);
    mkdirSync(repoRoot, { recursive: true });
    execFileSync("git", ["init", "--initial-branch=main"], { cwd: repoRoot, encoding: "utf-8" });
    return repoRoot;
  }

  beforeEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  afterAll(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it("creates an executable pre-commit hook that runs the staged-scope check", () => {
    const repoRoot = initRepo("create");

    const result = installGitPreCommitHook(repoRoot, { cliEntrypoint: FAKE_CLI });

    expect(result.action).toBe("created");
    const script = readFileSync(result.hookPath, "utf-8");
    // The hook must check the *staged* scope: unstaged edits are not part of the
    // commit being created.
    expect(script).toContain("verify --scope staged");
    expect(script).toContain("#!/bin/sh");
    // Runs under `sh`, so a Windows backslash path would be read as escapes.
    expect(script).not.toMatch(/node "[A-Za-z]:\\\\/);
  });

  it("maps WhyGuard's exit 2 to a failing hook, but lets other failures through", () => {
    const repoRoot = initRepo("exit-codes");

    const script = readFileSync(
      installGitPreCommitHook(repoRoot, { cliEntrypoint: FAKE_CLI }).hookPath,
      "utf-8",
    );

    // Exit 2 is the documented "block" decision -> abort the commit.
    expect(script).toContain("if [ $status -eq 2 ]");
    expect(script).toContain("exit 1");
    // Any other non-zero exit is a WhyGuard failure, and must not claim the
    // code is unsafe" — a broken analyzer must not block valid work.
    expect(script).toContain("Allowing the commit.");
  });

  it("supports a visible human override via WHYGUARD_SKIP", () => {
    const repoRoot = initRepo("skip");

    const script = readFileSync(
      installGitPreCommitHook(repoRoot, { cliEntrypoint: FAKE_CLI }).hookPath,
      "utf-8",
    );

    expect(script).toContain("WHYGUARD_SKIP");
  });

  it("upgrades a hook it previously installed, in place", () => {
    const repoRoot = initRepo("upgrade");
    installGitPreCommitHook(repoRoot, { cliEntrypoint: FAKE_CLI });

    const result = installGitPreCommitHook(repoRoot, { cliEntrypoint: FAKE_CLI });

    expect(result.action).toBe("upgraded");
  });

  it("refuses to clobber a pre-commit hook it does not manage", () => {
    // A team's existing gate (Husky, lint-staged, a custom convention) must not be
    // silently deleted — that would remove protection while claiming to add it.
    const repoRoot = initRepo("foreign");
    const hooksDir = join(repoRoot, ".git", "hooks");
    mkdirSync(hooksDir, { recursive: true });
    const foreignScript = "#!/bin/sh\necho 'team hook'\n";
    writeFileSync(join(hooksDir, "pre-commit"), foreignScript, "utf-8");

    const result = installGitPreCommitHook(repoRoot, { cliEntrypoint: FAKE_CLI });

    expect(result.action).toBe("skipped-foreign-hook");
    expect(readFileSync(join(hooksDir, "pre-commit"), "utf-8")).toBe(foreignScript);
  });

  it("replaces a foreign hook only when --force is requested", () => {
    const repoRoot = initRepo("forced");
    const hooksDir = join(repoRoot, ".git", "hooks");
    mkdirSync(hooksDir, { recursive: true });
    writeFileSync(join(hooksDir, "pre-commit"), "#!/bin/sh\necho 'team hook'\n", "utf-8");

    const result = installGitPreCommitHook(repoRoot, { force: true, cliEntrypoint: FAKE_CLI });

    expect(result.action).toBe("created");
    expect(readFileSync(result.hookPath, "utf-8")).toContain("verify --scope staged");
  });
});
