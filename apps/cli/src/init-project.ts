import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { installGitPreCommitHook, resolveCliEntrypoint } from "./install-git-hook.js";

/**
 * `whyguard init` — makes a target repository guarded in one command.
 *
 * Why this exists: every enforcement layer WhyGuard offers was already implemented,
 * but wiring them up meant hand-editing JSON with absolute paths. That is exactly
 * where a real setup attempt failed during manual verification — a hook was copied
 * into a project whose paths did not match, so it ran and silently guarded nothing.
 * Configuration a human has to assemble by hand is configuration that will be wrong,
 * and a guardrail that is wrong is worse than one that is absent, because it looks
 * installed.
 *
 * Everything written here is idempotent and additive: re-running updates WhyGuard's
 * own entries in place, merges into shared config files rather than replacing them,
 * and refuses to clobber a file it does not recognize unless `--force` is passed.
 */

/** Extensions the MVP detector understands (TS/JS only). */
const ANALYZABLE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];

/**
 * Below this many commits, historical evidence gathering has little to work with and
 * findings will mostly come back `unknown`. Not a hard failure — a young repository is
 * a documented poor fit, not an error — but the user must be told at
 * install time rather than discovering it as apparent silence later.
 */
const MIN_USEFUL_COMMITS = 20;

export type RepositoryAssessment = {
  /** The Git top-level directory, which is what every generated path is anchored to. */
  repoRoot: string;
  commitCount: number;
  analyzableFileCount: number;
  /** Non-fatal conditions that will limit how useful WhyGuard is in this repository. */
  warnings: string[];
};

function git(repoRoot: string, args: string[]): string {
  return execFileSync("git", args, { cwd: repoRoot, encoding: "utf-8" }).trim();
}

/**
 * Verifies the target is a Git repository and reports what WhyGuard will actually be
 * able to do with it.
 *
 * Resolves the Git top level rather than trusting the path given: running `init` from
 * a subdirectory must configure the repository, not create a stray `.kiro` folder
 * halfway down the tree.
 */
export function assessRepository(targetPath: string): RepositoryAssessment {
  const requested = resolve(targetPath);
  if (!existsSync(requested)) {
    throw new Error(`Path does not exist: ${requested}`);
  }

  let repoRoot: string;
  try {
    repoRoot = resolve(git(requested, ["rev-parse", "--show-toplevel"]));
  } catch {
    throw new Error(
      `${requested} is not inside a Git repository. WhyGuard reconstructs why code ` +
        "exists from Git history, so there is nothing to protect without one.",
    );
  }

  const warnings: string[] = [];

  const commitCount = Number(git(repoRoot, ["rev-list", "--count", "HEAD"]) || "0");
  const trackedFiles = git(repoRoot, ["ls-files"]).split("\n");
  const analyzableFileCount = trackedFiles.filter((file) =>
    ANALYZABLE_EXTENSIONS.some((extension) => file.endsWith(extension)),
  ).length;

  if (analyzableFileCount === 0) {
    warnings.push(
      "No tracked TypeScript/JavaScript files found. The MVP detector only understands " +
        "TS/JS, so nothing in this repository will be analyzed yet.",
    );
  }

  if (commitCount < MIN_USEFUL_COMMITS) {
    warnings.push(
      `Only ${commitCount} commit(s) of history. WhyGuard derives evidence from commits, ` +
        "issues and pull requests, so most findings here will report an unknown reason " +
        "until the repository accumulates history (or you add rationale contracts).",
    );
  }

  if (existsSync(join(repoRoot, ".git", "shallow"))) {
    warnings.push(
      "This is a shallow clone. History tracing (git log -S) cannot see past the " +
        "shallow boundary — run `git fetch --unshallow` for full evidence.",
    );
  }

  return { repoRoot, commitCount, analyzableFileCount, warnings };
}

/**
 * Locates the built MCP server entrypoint, which lives alongside the CLI inside the
 * same `apps/` directory. Returns null when it is not present (for example a CLI
 * distributed on its own), so `init` can skip the MCP step with an explicit note
 * instead of writing a config that points at a file that does not exist.
 */
function resolveMcpServerEntrypoint(cliEntrypoint: string): string | null {
  //.../apps/cli/dist/index.js ->.../apps/mcp-server/dist/index.js
  const appsDir = dirname(dirname(dirname(cliEntrypoint)));
  const candidate = join(appsDir, "mcp-server", "dist", "index.js");
  return existsSync(candidate) ? candidate : null;
}

/** Paths inside a generated config are written with forward slashes: JSON, and `sh`. */
function forwardSlashes(path: string): string {
  return path.split("\\").join("/");
}

function writeJsonFile(filePath: string, value: unknown): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

function readJsonFile(filePath: string): Record<string, unknown> | null {
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, "utf-8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export type FileOutcome = "created" | "updated" | "unchanged" | "skipped-unrecognized";

export type InitStepResult = {
  filePath: string;
  outcome: FileOutcome;
  /** Present when the step was skipped, explaining what the user should do instead. */
  note?: string;
};

const KIRO_HOOK_FILE = join(".kiro", "hooks", "whyguard-guard.json");

/**
 * Builds the Kiro hook definitions for a target repository.
 *
 * Two hooks, deliberately, because they guarantee different things:
 * - `PreToolUse` with `--on-block ask` returns a Kiro permission decision, so the IDE
 *   prompts the human. A plain exit 2 is only advisory and was verified to be ignored
 *   by real models.
 * - `Stop` runs `verify` after the agent's turn, catching a removal that slipped
 *   through for any reason, since it inspects the result rather than asking permission.
 */
function buildKiroHooks(repoRoot: string, cliEntrypoint: string): unknown {
  const cli = forwardSlashes(cliEntrypoint);
  const repo = forwardSlashes(repoRoot);

  return {
    version: "v1",
    hooks: [
      {
        name: "WhyGuard PreToolUse Guard",
        trigger: "PreToolUse",
        description:
          "Generated by `whyguard init`. Before any file write, checks whether the edit " +
          "removes historically protected behavior. On a block it returns a " +
          "permissionDecision of 'ask' so Kiro prompts you to confirm — an agent can " +
          "ignore a plain exit 2, but cannot bypass the IDE's own prompt.",
        matcher: "fs_write|str_replace",
        action: {
          type: "command",
          command: `node "${cli}" hook --repo "${repo}" --on-block ask`,
          timeout: 15,
        },
      },
      {
        name: "WhyGuard Stop Verification",
        trigger: "Stop",
        description:
          "Generated by `whyguard init`. After the agent finishes, re-checks the " +
          "checkout for protected behavior that was removed anyway. Inspects the result " +
          "instead of asking permission, so it still reports what slipped through.",
        action: {
          type: "command",
          command: `node "${cli}" verify --scope working-tree --repo "${repo}"`,
          timeout: 60,
        },
      },
    ],
  };
}

function isWhyGuardHookFile(existing: Record<string, unknown> | null): boolean {
  if (!existing) return false;
  const hooks = existing.hooks;
  if (!Array.isArray(hooks)) return false;
  return hooks.some(
    (hook) =>
      typeof hook === "object" &&
      hook !== null &&
      typeof (hook as { name?: unknown }).name === "string" &&
      (hook as { name: string }).name.startsWith("WhyGuard"),
  );
}

function writeKiroHooks(repoRoot: string, cliEntrypoint: string, force: boolean): InitStepResult {
  const filePath = join(repoRoot, KIRO_HOOK_FILE);
  const existing = readJsonFile(filePath);

  if (existsSync(filePath) && !isWhyGuardHookFile(existing) && !force) {
    return {
      filePath,
      outcome: "skipped-unrecognized",
      note:
        "A hook file already exists that WhyGuard did not generate. Refusing to " +
        "replace it — inspect it and merge manually, or re-run with --force.",
    };
  }

  const desired = buildKiroHooks(repoRoot, cliEntrypoint);
  const desiredText = `${JSON.stringify(desired, null, 2)}\n`;
  const currentText = existsSync(filePath) ? readFileSync(filePath, "utf-8") : null;

  if (currentText === desiredText) return { filePath, outcome: "unchanged" };

  writeJsonFile(filePath, desired);
  return { filePath, outcome: currentText === null ? "created" : "updated" };
}

const MCP_CONFIG_FILE = join(".kiro", "settings", "mcp.json");

/**
 * Merges WhyGuard's MCP server into the target repository's `mcp.json`, preserving
 * every other server already configured there. Replacing the file wholesale would
 * silently disable a developer's other MCP servers — a config file is shared
 * territory, not WhyGuard's to own.
 */
function writeMcpConfig(
  repoRoot: string,
  cliEntrypoint: string,
  databaseUrl: string | undefined,
  explicitMcpEntrypoint: string | undefined,
): InitStepResult {
  const filePath = join(repoRoot, MCP_CONFIG_FILE);
  const mcpEntrypoint = explicitMcpEntrypoint ?? resolveMcpServerEntrypoint(cliEntrypoint);

  if (!mcpEntrypoint) {
    return {
      filePath,
      outcome: "skipped-unrecognized",
      note:
        "Built MCP server not found next to the CLI, so no MCP config was written. " +
        "Run `pnpm build` in the WhyGuard repository and re-run init to enable the " +
        "MCP tools (the hooks and Git guard work without it).",
    };
  }

  const existing = readJsonFile(filePath) ?? {};
  const servers =
    typeof existing.mcpServers === "object" && existing.mcpServers !== null
      ? { ...(existing.mcpServers as Record<string, unknown>) }
      : {};

  servers.whyguard = {
    command: "node",
    args: [forwardSlashes(mcpEntrypoint)],
    env: {
      WHYGUARD_REPO_ROOT: forwardSlashes(repoRoot),
      // Without a database, get_finding can only resolve findings computed in the
      // same session — a finding id from a GitHub Check would not resolve.
      ...(databaseUrl ? { DATABASE_URL: databaseUrl } : {}),
    },
    disabled: false,
    // register_decision writes to the repository and must always require explicit
    // human confirmation. Never pre-approve it.
    autoApprove: [],
    disabledTools: [],
  };

  const desired = { ...existing, mcpServers: servers };
  const desiredText = `${JSON.stringify(desired, null, 2)}\n`;
  const currentText = existsSync(filePath) ? readFileSync(filePath, "utf-8") : null;

  if (currentText === desiredText) return { filePath, outcome: "unchanged" };

  writeJsonFile(filePath, desired);
  return { filePath, outcome: currentText === null ? "created" : "updated" };
}

const EXAMPLE_DECISION_FILE = join(".whyguard", "decisions", "EXAMPLE.yml");

/**
 * Rationale contracts are the strongest signal WhyGuard accepts: an active contract
 * turns a heuristically "proposed" property into a human-confirmed one and its
 * evidence into `strong`, which is the difference between a warning and a block.
 * Almost nobody discovers that from documentation alone, so `init` seeds a commented
 * template in the right place.
 *
 * Written with a `status: draft` and an `EXAMPLE` id so it can never accidentally
 * start guarding real code — `findMatchingContract` only considers `active` contracts.
 */
const EXAMPLE_DECISION = `# WhyGuard rationale contract — TEMPLATE (inactive)
#
# A rationale contract is how you tell WhyGuard "this behavior exists on purpose".
# It is the strongest evidence the tool accepts: with an active contract, removing the
# behavior becomes a BLOCK instead of a warning, because a human already confirmed why
# the code is there.
#
# To use it:
#   1. Copy this file to a real name, e.g. .whyguard/decisions/payment-idempotency.yml
#   2. Fill in the real file, symbol, reason and evidence.
#   3. Change status to "active".
#
# WhyGuard ignores this template: only contracts with status "active" are matched, and
# the id below is a placeholder.

id: EXAMPLE
version: 1
status: draft

# Which code this decision protects. Paths are relative to the repository root.
scope:
  files:
    - src/path/to/file.ts
  symbols:
    - functionName

# WHY the behavior exists. Write the incident, not the implementation.
reason: >
  Describe the problem this code prevents. For example: clients retry checkout
  requests when the payment gateway times out, so without a guard a retry creates a
  second order and charges the customer twice.

# The behavior that must survive any refactor. State it as an observable property,
# never as "keep these lines" — a rewrite that preserves the property is fine.
must_preserve:
  - One idempotency key creates at most one order.

# Where the reason is documented. These become the evidence trail on every finding.
evidence:
  - type: issue
    id: "481"
  - type: pull_request
    id: "493"

# Tests that prove the property. A change with an equivalent regression test is not
# blocked, so listing these here is how a safe refactor gets through.
required_tests:
  - tests/payments/idempotency.test.ts

# When this decision stops being true. Documenting the exit condition keeps the
# contract from outliving the reason it was written for.
expires_when:
  - Every supported payment provider guarantees server-side idempotency.

owners:
  - your-team
`;

function writeExampleDecision(repoRoot: string): InitStepResult {
  const filePath = join(repoRoot, EXAMPLE_DECISION_FILE);

  if (existsSync(filePath)) {
    const current = readFileSync(filePath, "utf-8");
    if (current === EXAMPLE_DECISION) return { filePath, outcome: "unchanged" };
    // The user may have edited the template. Never overwrite their edits — the
    // template is a one-time convenience, not something WhyGuard owns.
    return {
      filePath,
      outcome: "skipped-unrecognized",
      note: "Template already exists and differs from the default; left untouched.",
    };
  }

  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, EXAMPLE_DECISION, "utf-8");
  return { filePath, outcome: "created" };
}

export type InitProjectOptions = {
  force?: boolean;
  /** Passed through to the MCP server so `get_finding` can resolve persisted findings. */
  databaseUrl?: string;
  /** Skip the Git hook (for a repository where commits are gated elsewhere). */
  skipGitHook?: boolean;
  /** Skip the Kiro hook + MCP config (for a repository not used with Kiro). */
  skipKiro?: boolean;
  /**
   * Overrides the CLI entrypoint written into generated configuration. Lets callers
   * and tests run without build output present, since `resolveCliEntrypoint` throws
   * when `dist/` is missing.
   */
  cliEntrypoint?: string;
  /**
   * Overrides the MCP server entrypoint. When omitted it is derived from the CLI's
   * location and must exist on disk — an explicit value is trusted as-is, so the
   * caller is asserting it is correct.
   */
  mcpServerEntrypoint?: string;
};

export type InitProjectResult = {
  assessment: RepositoryAssessment;
  gitHook?: { hookPath: string; action: string };
  steps: InitStepResult[];
};

export function initProject(
  targetPath: string,
  options: InitProjectOptions = {},
): InitProjectResult {
  const assessment = assessRepository(targetPath);
  const { repoRoot } = assessment;
  const cliEntrypoint = options.cliEntrypoint ?? resolveCliEntrypoint();

  const steps: InitStepResult[] = [];
  let gitHook: InitProjectResult["gitHook"];

  if (!options.skipGitHook) {
    const result = installGitPreCommitHook(repoRoot, { force: options.force, cliEntrypoint });
    gitHook = { hookPath: result.hookPath, action: result.action };
  }

  if (!options.skipKiro) {
    steps.push(writeKiroHooks(repoRoot, cliEntrypoint, options.force === true));
    steps.push(
      writeMcpConfig(repoRoot, cliEntrypoint, options.databaseUrl, options.mcpServerEntrypoint),
    );
  }

  steps.push(writeExampleDecision(repoRoot));

  return { assessment, gitHook, steps };
}
