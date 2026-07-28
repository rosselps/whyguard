import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Installs WhyGuard as a Git `pre-commit` hook's enforcement layering.
 *
 * Why this layer exists: a Kiro `PreToolUse` hook is the earliest signal but the
 * weakest guarantee — it is advisory to the agent, and two different models were
 * observed applying a protected-behavior-removing edit after receiving a block
 * (see `BlockOutputMode` in index.ts). Git, by contrast, aborts the commit itself
 * when `pre-commit` exits non-zero. No agent or model can talk its way past that,
 * which makes this the layer that actually holds.
 *
 * The generated hook is a POSIX shell script. Git for Windows runs hooks through its
 * bundled `sh`, so a single `sh` script works on Windows, macOS, and Linux without
 * needing a `.cmd` variant.
 */

/** Markers used to recognize a hook this installer wrote (so it can be upgraded in place). */
const HOOK_MARKER_START = "# >>> whyguard pre-commit guard >>>";
const HOOK_MARKER_END = "# <<< whyguard pre-commit guard <<<";

export type InstallGitHookResult = {
  hookPath: string;
  action: "created" | "upgraded" | "skipped-foreign-hook";
  /** Absolute path to the CLI entrypoint the hook will invoke. */
  cliEntrypoint: string;
};

/**
 * Resolves the repository's `.git/hooks` directory via `git rev-parse --git-path hooks`,
 * which correctly handles worktrees, submodules, and a `core.hooksPath` override rather
 * than assuming a literal `<repoRoot>/.git/hooks`.
 */
function resolveHooksDir(repoRoot: string): string {
  const output = execFileSync(
    "git",
    ["rev-parse", "--path-format=absolute", "--git-path", "hooks"],
    {
      cwd: repoRoot,
      encoding: "utf-8",
    },
  ).trim();
  return resolve(repoRoot, output);
}

/**
 * Absolute path to this CLI's own **built** entrypoint, so the installed hook keeps
 * working regardless of the developer's shell, `PATH`, or current directory when
 * committing.
 *
 * The installed hook runs `node <entrypoint>`, so it must point at real JavaScript.
 * Resolution has to work across three shapes the CLI actually ships in: run from
 * source through `tsx`, run from the compiled monorepo (`dist/index.js`), and installed
 * from npm as a single bundled file (`dist-bundle/whyguard.js`). Assuming a sibling
 * named `index.js` broke the published package outright — `init` failed on every run
 * with "could not locate the built entrypoint", found only by installing the packed
 * tarball.
 *
 * Failing loudly beats installing a hook that silently errors on every commit: per the
 * exit-code contract, such a hook would be read as "could not complete" and wave every
 * commit through.
 */
export function resolveCliEntrypoint(): string {
  const candidates: string[] = [];

  // Preferred: the script Node is actually executing. This is exactly what a hook
  // should re-invoke, and it is correct in every distribution shape without knowing
  // any of their filenames — `dist/index.js` when run from the compiled monorepo,
  // `dist-bundle/whyguard.js` when installed from npm. Guarded to real JavaScript
  // because under `tsx` this is a `.ts` file that plain `node` cannot run.
  const executed = process.argv[1];
  if (executed && /\.[cm]?js$/.test(executed)) {
    candidates.push(resolve(executed));
  }

  // Fallback for callers that are not the CLI's own entrypoint (a test, an embedding
  // program): the compiled sibling next to this module.
  const sibling = fileURLToPath(new URL("./index.js", import.meta.url));
  candidates.push(sibling);

  const fromSource = sibling.split("\\").join("/");
  if (fromSource.includes("/src/")) {
    candidates.push(resolve(fromSource.replace("/src/", "/dist/")));
  }

  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new Error(
      `Could not locate the built WhyGuard CLI entrypoint (looked in: ${candidates.join(", ")}). ` +
        `Run "pnpm build" first — the Git hook runs "node <entrypoint>" and needs compiled output.`,
    );
  }
  return found;
}

function buildHookScript(cliEntrypoint: string): string {
  // Forward-slash the path: the script runs under `sh`, where a Windows backslash
  // path would be read as escape sequences.
  const entrypointForShell = cliEntrypoint.split("\\").join("/");

  return `#!/bin/sh
${HOOK_MARKER_START}
# Installed by "whyguard install-hooks". Blocks a commit that removes protected
# historical behavior. Regenerate with: whyguard install-hooks --force
#
# Escape hatch: WHYGUARD_SKIP=1 git commit ...   (or git commit --no-verify)
# Both are deliberate, visible, auditable human overrides -- unlike an agent
# silently ignoring an advisory PreToolUse block.

if [ "\${WHYGUARD_SKIP}" = "1" ]; then
  echo "WhyGuard: pre-commit check skipped (WHYGUARD_SKIP=1)."
  exit 0
fi

node "${entrypointForShell}" verify --scope staged
status=$?

# Exit 2 is the documented "block" decision. Any other non-zero exit is a
# WhyGuard failure, which must not be read as "the code is unsafe", and must not
# silently block an otherwise-valid commit.
if [ $status -eq 2 ]; then
  exit 1
fi

if [ $status -ne 0 ]; then
  echo "WhyGuard: check could not complete (exit $status). Allowing the commit." >&2
fi

exit 0
${HOOK_MARKER_END}
`;
}

export type InstallGitHookOptions = {
  force?: boolean;
  /**
   * Overrides the CLI entrypoint the generated hook invokes.
   *
   * Exists so callers (and tests) do not have to depend on build output being present:
   * `resolveCliEntrypoint` throws when `dist/` is missing, which would otherwise make
   * this function unusable until after a build.
   */
  cliEntrypoint?: string;
};

export function installGitPreCommitHook(
  repoRoot: string,
  options: InstallGitHookOptions = {},
): InstallGitHookResult {
  const hooksDir = resolveHooksDir(repoRoot);
  mkdirSync(hooksDir, { recursive: true });
  const hookPath = join(hooksDir, "pre-commit");
  const cliEntrypoint = options.cliEntrypoint ?? resolveCliEntrypoint();

  let action: InstallGitHookResult["action"] = "created";

  if (existsSync(hookPath)) {
    const existing = readFileSync(hookPath, "utf-8");
    const isOurs = existing.includes(HOOK_MARKER_START);

    if (!isOurs && !options.force) {
      // Never clobber a hook someone else installed (Husky, lint-staged, a team
      // convention). Refusing loudly is safer than silently deleting their gate.
      return { hookPath, action: "skipped-foreign-hook", cliEntrypoint };
    }
    action = isOurs ? "upgraded" : "created";
  }

  writeFileSync(hookPath, buildHookScript(cliEntrypoint), "utf-8");
  // Git requires the hook to be executable on POSIX systems; harmless on Windows.
  try {
    chmodSync(hookPath, 0o755);
  } catch {
    // Filesystems without POSIX permissions (some Windows setups) reject chmod;
    // Git for Windows does not require the bit, so this is not fatal.
  }

  return { hookPath, action, cliEntrypoint };
}
