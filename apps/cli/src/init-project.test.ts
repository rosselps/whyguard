import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { assessRepository, initProject } from "./init-project.js";

/**
 * Tests for `whyguard init`. The behavior that matters here is not "did it write
 * files" but "is it safe to run on a repository that already has configuration" —
 * `init` touches shared config files (`mcp.json`) and a directory other tools also
 * use (`.kiro/`), so clobbering is the failure mode to guard against.
 */
describe("whyguard init", () => {
  /**
   * Deliberately outside the WhyGuard checkout, not under `.tmp/`.
   *
   * `assessRepository` resolves the Git top level by walking up, which is the correct
   * behavior (running `init` from a subdirectory should configure the repository).
   * But it means a "plain directory" fixture created inside this repository is *not*
   * outside a repository at all — it resolves to WhyGuard itself. Testing the
   * not-a-repository path requires a location with no Git repository above it.
   */
  const tempRoot = join(tmpdir(), "whyguard-init-test");

  /** Pinned like every other fixture Git call, so Git can never escape to the parent repo. */
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

  function makeRepo(name: string, options: { commits?: number; withTs?: boolean } = {}): string {
    const repoRoot = join(tempRoot, name);
    mkdirSync(repoRoot, { recursive: true });
    execFileSync("git", ["-c", "core.hooksPath=", "init", "--initial-branch=main"], {
      cwd: repoRoot,
      encoding: "utf-8",
      env: { ...process.env, GIT_CEILING_DIRECTORIES: dirname(repoRoot) },
    });
    git(repoRoot, ["config", "user.email", "t@whyguard.local"]);
    git(repoRoot, ["config", "user.name", "T"]);

    const commits = options.commits ?? 1;
    for (let i = 0; i < commits; i += 1) {
      const file = options.withTs === false ? `notes-${i}.md` : `src/file-${i}.ts`;
      mkdirSync(dirname(join(repoRoot, file)), { recursive: true });
      writeFileSync(join(repoRoot, file), `export const v${i} = ${i};\n`, "utf-8");
      git(repoRoot, ["add", "."]);
      git(repoRoot, ["commit", "-m", `commit ${i}`]);
    }
    return repoRoot;
  }

  /**
   * A stand-in for the built CLI path. Passed explicitly so these tests never depend
   * on `dist/` existing: `test` only dependsOn `^build` (dependencies' builds), not the
   * package's own, so relying on build output made the whole file fail intermittently
   * inside a full `pnpm test` run while passing in isolation.
   */
  const FAKE_CLI = "C:/fake/whyguard/apps/cli/dist/index.js";
  const FAKE_MCP = "C:/fake/whyguard/apps/mcp-server/dist/index.js";

  function init(repoRoot: string, options: Parameters<typeof initProject>[1] = {}) {
    return initProject(repoRoot, {
      cliEntrypoint: FAKE_CLI,
      mcpServerEntrypoint: FAKE_MCP,
      ...options,
    });
  }

  beforeEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  afterAll(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  describe("assessRepository", () => {
    it("refuses a path that is not inside a Git repository", () => {
      const notARepo = join(tempRoot, "plain-dir");
      mkdirSync(notARepo, { recursive: true });

      expect(() => assessRepository(notARepo)).toThrow(/not inside a Git repository/);
    });

    it("resolves the Git top level when run from a subdirectory", () => {
      // Running init from a subdirectory must configure the repository, not scatter a
      // stray.kiro folder halfway down the tree.
      const repoRoot = makeRepo("from-subdir");
      const subdir = join(repoRoot, "src");

      expect(assessRepository(subdir).repoRoot).toBe(repoRoot);
    });

    it("warns when a repository has too little history to derive evidence from", () => {
      const repoRoot = makeRepo("shallow-history", { commits: 2 });

      const warnings = assessRepository(repoRoot).warnings.join(" ");
      expect(warnings).toMatch(/history/i);
    });

    it("warns when there are no analyzable TS/JS files", () => {
      const repoRoot = makeRepo("docs-only", { withTs: false });

      const assessment = assessRepository(repoRoot);
      expect(assessment.analyzableFileCount).toBe(0);
      expect(assessment.warnings.join(" ")).toMatch(/TypeScript\/JavaScript/i);
    });
  });

  describe("initProject", () => {
    it("installs the Git hook, Kiro hooks and a decision template", () => {
      const repoRoot = makeRepo("full");

      const result = init(repoRoot);

      expect(result.gitHook?.action).toBe("created");
      expect(existsSync(join(repoRoot, ".kiro", "hooks", "whyguard-guard.json"))).toBe(true);
      expect(existsSync(join(repoRoot, ".whyguard", "decisions", "EXAMPLE.yml"))).toBe(true);
    });

    it("anchors generated commands to the resolved repo root, with forward slashes", () => {
      // The original manual setup failed precisely because hand-written paths did not
      // match the target repository: the hook ran and guarded nothing.
      const repoRoot = makeRepo("paths");

      init(repoRoot);
      const hooks = readFileSync(join(repoRoot, ".kiro", "hooks", "whyguard-guard.json"), "utf-8");

      expect(hooks).toContain(repoRoot.split("\\").join("/"));
      expect(hooks).toContain("--on-block ask");
      expect(hooks).toContain("verify --scope working-tree");
      // A backslash path inside the JSON command would break once passed to a shell.
      expect(hooks).not.toContain("\\\\");
    });

    it("is idempotent: a second run reports unchanged rather than rewriting", () => {
      const repoRoot = makeRepo("idempotent");
      init(repoRoot);

      const second = init(repoRoot);

      for (const step of second.steps) {
        expect(["unchanged", "skipped-unrecognized"]).toContain(step.outcome);
      }
      expect(second.gitHook?.action).toBe("upgraded");
    });

    it("preserves other MCP servers already configured in mcp.json", () => {
      // mcp.json is shared territory. Replacing it would silently disable a
      // developer's other MCP servers while claiming to add protection.
      const repoRoot = makeRepo("mcp-merge");
      const mcpPath = join(repoRoot, ".kiro", "settings", "mcp.json");
      mkdirSync(dirname(mcpPath), { recursive: true });
      writeFileSync(
        mcpPath,
        JSON.stringify({ mcpServers: { existing: { command: "npx", args: ["other"] } } }, null, 2),
        "utf-8",
      );

      init(repoRoot);
      const merged = JSON.parse(readFileSync(mcpPath, "utf-8")) as {
        mcpServers: Record<string, { command: string; autoApprove?: unknown[] }>;
      };

      expect(merged.mcpServers.existing?.command).toBe("npx");
      expect(merged.mcpServers.whyguard?.command).toBe("node");
      // register_decision writes to the repo and must never be pre-approved.
      expect(merged.mcpServers.whyguard?.autoApprove).toEqual([]);
    });

    it("refuses to replace a hook file WhyGuard did not generate", () => {
      const repoRoot = makeRepo("foreign-hooks");
      const hookPath = join(repoRoot, ".kiro", "hooks", "whyguard-guard.json");
      mkdirSync(dirname(hookPath), { recursive: true });
      const foreign = JSON.stringify({ version: "v1", hooks: [{ name: "Team Hook" }] }, null, 2);
      writeFileSync(hookPath, foreign, "utf-8");

      const result = init(repoRoot);

      const step = result.steps.find((entry) => entry.filePath === hookPath);
      expect(step?.outcome).toBe("skipped-unrecognized");
      expect(readFileSync(hookPath, "utf-8")).toBe(foreign);
    });

    it("replaces a foreign hook file only with --force", () => {
      const repoRoot = makeRepo("forced-hooks");
      const hookPath = join(repoRoot, ".kiro", "hooks", "whyguard-guard.json");
      mkdirSync(dirname(hookPath), { recursive: true });
      writeFileSync(hookPath, JSON.stringify({ hooks: [{ name: "Team Hook" }] }), "utf-8");

      init(repoRoot, { force: true });

      expect(readFileSync(hookPath, "utf-8")).toContain("WhyGuard PreToolUse Guard");
    });

    it("does not overwrite a decision template the user has edited", () => {
      const repoRoot = makeRepo("edited-template");
      init(repoRoot);
      const templatePath = join(repoRoot, ".whyguard", "decisions", "EXAMPLE.yml");
      writeFileSync(templatePath, "id: my-own-edits\n", "utf-8");

      init(repoRoot);

      expect(readFileSync(templatePath, "utf-8")).toBe("id: my-own-edits\n");
    });

    it("seeds the template as an inactive draft so it cannot guard real code by accident", () => {
      const repoRoot = makeRepo("template-inactive");

      init(repoRoot);
      const template = readFileSync(
        join(repoRoot, ".whyguard", "decisions", "EXAMPLE.yml"),
        "utf-8",
      );

      // Only `active` contracts are matched, so a seeded template must not be active.
      expect(template).toContain("status: draft");
    });

    it("honours --skip-git-hook and --skip-kiro", () => {
      const repoRoot = makeRepo("skips");

      const result = init(repoRoot, { skipGitHook: true, skipKiro: true });

      expect(result.gitHook).toBeUndefined();
      expect(existsSync(join(repoRoot, ".kiro", "hooks", "whyguard-guard.json"))).toBe(false);
      // The decision template is always useful, so it is still written.
      expect(existsSync(join(repoRoot, ".whyguard", "decisions", "EXAMPLE.yml"))).toBe(true);
    });

    it("passes a database url through to the MCP server env when provided", () => {
      const repoRoot = makeRepo("db-url");

      init(repoRoot, { databaseUrl: "file:./data/whyguard.db" });
      const mcp = JSON.parse(
        readFileSync(join(repoRoot, ".kiro", "settings", "mcp.json"), "utf-8"),
      ) as { mcpServers: { whyguard: { env: Record<string, string> } } };

      expect(mcp.mcpServers.whyguard.env.DATABASE_URL).toBe("file:./data/whyguard.db");
      expect(mcp.mcpServers.whyguard.env.WHYGUARD_REPO_ROOT).toBe(repoRoot.split("\\").join("/"));
    });
  });
});
