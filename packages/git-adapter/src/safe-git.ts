import { execFileSync } from "node:child_process";
import { resolve, sep } from "node:path";

/**
 * Safe wrappers around Git commands and 20.
 *
 * Rules enforced here:
 * - Never build a shell string; always call `git` with an argument array (no shell).
 * - Validate SHAs/refs before use.
 * - Validate that file paths resolve inside the repository root (no path traversal).
 */

const SHA_OR_REF_PATTERN = /^[A-Za-z0-9._/\-^~]{1,200}$/;

export class InvalidGitArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidGitArgumentError";
  }
}

export function assertValidRef(ref: string): void {
  if (!SHA_OR_REF_PATTERN.test(ref)) {
    throw new InvalidGitArgumentError(`Refusing to use unsafe Git ref/SHA: ${JSON.stringify(ref)}`);
  }
}

/** Ensures `filePath` stays inside `repoRoot` after resolution (blocks path traversal). */
export function assertPathInsideRepo(repoRoot: string, filePath: string): string {
  const resolvedRoot = resolve(repoRoot);
  const resolvedPath = resolve(repoRoot, filePath);
  if (resolvedPath !== resolvedRoot && !resolvedPath.startsWith(resolvedRoot + sep)) {
    throw new InvalidGitArgumentError(
      `Refusing to access path outside repository root: ${JSON.stringify(filePath)}`,
    );
  }
  return resolvedPath;
}

/**
 * Explicit because `execFileSync` inherits the parent's stderr by default. That printed
 * `fatal:...` to the user's terminal for every handled failure (such as `getFileAtRef`
 * probing a path absent at a ref), left `err.stderr` empty, and defeated credential
 * redaction — Git prints the full remote URL in its own error output, so a failing
 * authenticated clone leaked its token regardless of what the thrown Error said.
 */
const GIT_STDIO = ["ignore", "pipe", "pipe"] as const;

function runGit(repoRoot: string, args: string[]): string {
  try {
    return execFileSync("git", args, {
      cwd: repoRoot,
      encoding: "utf-8",
      maxBuffer: 1024 * 1024 * 32,
      stdio: [...GIT_STDIO],
    });
  } catch (error) {
    const err = error as { stderr?: string; message?: string };
    throw new Error(
      `git ${args.join(" ")} failed: ${err.stderr ?? err.message ?? "unknown error"}`,
      {
        cause: error,
      },
    );
  }
}

export type ChangedFile = {
  /** Path at `head`. */
  path: string;
  status: "added" | "modified" | "deleted" | "renamed" | "unknown";
  /**
   * Path at `base`, set only for a rename. Callers reading the previous version of
   * the file must use this: `git show <base>:<newPath>` fails for a renamed file,
   * because that path did not exist yet at `base`.
   */
  previousPath?: string;
};

const STATUS_MAP: Record<string, ChangedFile["status"]> = {
  A: "added",
  M: "modified",
  D: "deleted",
  R: "renamed",
};

function parseNameStatus(output: string): ChangedFile[] {
  return output
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const [statusCode, ...pathParts] = line.split("\t");
      const status = STATUS_MAP[(statusCode ?? "").charAt(0)] ?? "unknown";
      const path = pathParts[pathParts.length - 1] ?? "";
      // A rename line is `R<score>\t<old>\t<new>`.
      const previousPath = status === "renamed" && pathParts.length > 1 ? pathParts[0] : undefined;
      return previousPath ? { path, status, previousPath } : { path, status };
    });
}

/** `git diff --name-status <base>..<head>` — list of changed files with status. */
export function getChangedFiles(repoRoot: string, base: string, head: string): ChangedFile[] {
  assertValidRef(base);
  assertValidRef(head);
  return parseNameStatus(runGit(repoRoot, ["diff", "--name-status", `${base}..${head}`]));
}

/**
 * Which uncommitted changes to consider, for the two enforcement layers that run
 * against work that is not committed yet:
 *
 * - `"staged"`: only what `git commit` is about to record (`git diff --cached HEAD`).
 *   This is the correct scope for a `pre-commit` hook — unstaged edits are not part
 *   of the commit being created.
 * - `"working-tree"`: staged *and* unstaged edits (`git diff HEAD`). This is the
 *   correct scope for verifying what an agent just did to the checkout, since an
 *   agent's file writes are typically left unstaged.
 */
export type UncommittedScope = "staged" | "working-tree";

/**
 * Lists files changed relative to `HEAD` but not yet committed.
 *
 * Supports the two guardrail layers that do not compare two commits: the
 * `pre-commit` Git hook (`"staged"`) and the post-agent verification sweep
 * (`"working-tree"`).
 *
 * Untracked (never-added) files are intentionally excluded: WhyGuard compares a
 * file's previous committed behavior against its new content, and a brand-new file
 * has no previous behavior to protect.
 */
export function getUncommittedChangedFiles(
  repoRoot: string,
  scope: UncommittedScope = "working-tree",
): ChangedFile[] {
  const args = ["diff", "--name-status"];
  if (scope === "staged") args.push("--cached");
  args.push("HEAD");
  return parseNameStatus(runGit(repoRoot, args));
}

/**
 * Reads a file's content as `git commit` would record it: from the index when
 * `scope` is `"staged"`, or from the working tree otherwise.
 *
 * `git show:<path>` reads the staged blob, which is what a `pre-commit` hook must
 * inspect — reading the working-tree file instead would let a developer stage a
 * protected-behavior removal, then "fix" the file on disk without staging it, and
 * slip the staged removal past the guard.
 */
export function getStagedFileContent(repoRoot: string, filePath: string): string | null {
  assertPathInsideRepo(repoRoot, filePath);
  const normalizedPath = filePath.split(sep).join("/");
  try {
    return runGit(repoRoot, ["show", `:${normalizedPath}`]);
  } catch {
    return null;
  }
}

/** `git diff --unified=<context> <base>..<head> -- <path>` for a single file. */
export function getUnifiedDiff(
  repoRoot: string,
  base: string,
  head: string,
  filePath: string,
  context = 80,
): string {
  assertValidRef(base);
  assertValidRef(head);
  assertPathInsideRepo(repoRoot, filePath);
  return runGit(repoRoot, ["diff", `--unified=${context}`, `${base}..${head}`, "--", filePath]);
}

/** `git show <ref>:<path>` — file content at a specific ref, or null if it does not exist there. */
export function getFileAtRef(repoRoot: string, ref: string, filePath: string): string | null {
  assertValidRef(ref);
  assertPathInsideRepo(repoRoot, filePath);
  const normalizedPath = filePath.split(sep).join("/");
  try {
    return runGit(repoRoot, ["show", `${ref}:${normalizedPath}`]);
  } catch {
    return null;
  }
}

export type CommitInfo = {
  sha: string;
  authorName: string;
  authorEmail: string;
  date: string;
  subject: string;
  body: string;
};

/** `git show --format=fuller --stat` style metadata for a single commit. */
export function getCommitInfo(repoRoot: string, sha: string): CommitInfo {
  assertValidRef(sha);
  const format = ["%H", "%an", "%ae", "%aI", "%s", "%b"].join("%x1f");
  const output = runGit(repoRoot, ["show", "--no-patch", `--format=${format}`, sha]);
  const [fullSha = sha, authorName = "", authorEmail = "", date = "", subject = "", ...rest] =
    output.split("\x1f");
  return {
    sha: fullSha.trim(),
    authorName: authorName.trim(),
    authorEmail: authorEmail.trim(),
    date: date.trim(),
    subject: subject.trim(),
    body: rest.join("\x1f").trim(),
  };
}

/**
 * `git log -S'<fragment>' --all -- <path>` — commits whose diff added/removed an exact string.
 * Used to trace the commit that introduced a removed guard/condition.
 */
export function findCommitsByPickaxe(
  repoRoot: string,
  fragment: string,
  filePath?: string,
): CommitInfo[] {
  const args = ["log", `-S${fragment}`, "--all", "--format=%H"];
  if (filePath) {
    assertPathInsideRepo(repoRoot, filePath);
    args.push("--", filePath);
  }
  const output = runGit(repoRoot, args);
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((sha) => getCommitInfo(repoRoot, sha));
}

/** `git log -G'<regex>' --all -- <path>` — commits whose diff matches a regex. */
export function findCommitsByRegex(
  repoRoot: string,
  pattern: string,
  filePath?: string,
): CommitInfo[] {
  const args = ["log", `-G${pattern}`, "--all", "--format=%H"];
  if (filePath) {
    assertPathInsideRepo(repoRoot, filePath);
    args.push("--", filePath);
  }
  const output = runGit(repoRoot, args);
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((sha) => getCommitInfo(repoRoot, sha));
}

export type BlameEntry = {
  sha: string;
  line: number;
  content: string;
};

/** `git blame -L <start>,<end> <ref> -- <path>`. */
export function getBlame(
  repoRoot: string,
  ref: string,
  filePath: string,
  start: number,
  end: number,
): BlameEntry[] {
  assertValidRef(ref);
  assertPathInsideRepo(repoRoot, filePath);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) {
    throw new InvalidGitArgumentError(`Invalid blame line range: ${start},${end}`);
  }
  const output = runGit(repoRoot, [
    "blame",
    "--porcelain",
    "-L",
    `${start},${end}`,
    ref,
    "--",
    filePath,
  ]);
  const entries: BlameEntry[] = [];
  const lines = output.split("\n");
  let currentSha = "";
  let currentLine = 0;
  for (const line of lines) {
    const headerMatch = /^([0-9a-f]{40})\s+\d+\s+(\d+)/.exec(line);
    if (headerMatch) {
      currentSha = headerMatch[1] ?? "";
      currentLine = Number(headerMatch[2] ?? "0");
      continue;
    }
    if (line.startsWith("\t")) {
      entries.push({ sha: currentSha, line: currentLine, content: line.slice(1) });
    }
  }
  return entries;
}

/** Resolves a ref (branch, tag, HEAD, short SHA) to a full commit SHA. */
export function resolveRef(repoRoot: string, ref: string): string {
  assertValidRef(ref);
  return runGit(repoRoot, ["rev-parse", ref]).trim();
}

/**
 * Redacts credentials embedded in a Git remote URL (e.g. `https://x-access-token:<token>@...`)
 * before it can end up in a thrown error message or log line. "Redact tokens, authorization headers, and secrets from logs."
 */
function redactCredentialsInUrl(url: string): string {
  return url.replace(/:\/\/[^/@]+@/, "://***@");
}

function runGitWithRedactedUrl(repoRoot: string, args: string[], sensitiveUrl: string): string {
  try {
    return execFileSync("git", args, {
      cwd: repoRoot,
      encoding: "utf-8",
      maxBuffer: 1024 * 1024 * 32,
      stdio: [...GIT_STDIO],
    });
  } catch (error) {
    const err = error as { stderr?: string; message?: string };
    const rawMessage = err.stderr ?? err.message ?? "unknown error";
    const safeMessage = rawMessage.split(sensitiveUrl).join(redactCredentialsInUrl(sensitiveUrl));
    const safeArgs = args.map((arg) => (arg === sensitiveUrl ? redactCredentialsInUrl(arg) : arg));
    throw new Error(`git ${safeArgs.join(" ")} failed: ${safeMessage}`, { cause: error });
  }
}

/**
 * Clones a remote repository into `targetDir`. `cloneUrl` may embed a short-lived
 * installation token; any thrown error has the credential redacted.
 *
 * **Never shallow.** The pickaxe has to reach the commit that *introduced* the removed
 * logic, usually far older than the PR. `--depth` would silently degrade every finding
 * to "no historical reason found".
 *
 * **Not blobless either.** `--filter=blob:none` looked ideal since the pickaxe is
 * path-scoped, but measured on `sindresorhus/got` (1664 commits) it saved 2.4 MB and
 * took the same `git log -S` from 0.07s to 186.58s — the pickaxe round-trips for every
 * blob it lacks, and a Check on a multi-finding PR would time out.
 *
 * `--no-tags` is kept: tags are refs WhyGuard never reads.
 */
export function cloneRepository(cloneUrl: string, targetDir: string): void {
  runGitWithRedactedUrl(
    process.cwd(),
    ["clone", "--quiet", "--no-tags", cloneUrl, targetDir],
    cloneUrl,
  );
}

const REFSPEC_PATTERN = /^[A-Za-z0-9._/-]{1,200}$/;

/**
 * Fetches a specific refspec into the local repository. The canonical way to reach
 * it is `git fetch origin refs/pull/<number>/head`.
 */
export function fetchRefspec(repoRoot: string, refspec: string): void {
  if (!REFSPEC_PATTERN.test(refspec)) {
    throw new InvalidGitArgumentError(`Refusing to use unsafe refspec: ${JSON.stringify(refspec)}`);
  }
  runGit(repoRoot, ["fetch", "--quiet", "origin", refspec]);
}

/** Builds the `refs/pull/<number>/head` refspec GitHub exposes for every Pull Request. */
export function pullRequestHeadRefspec(pullNumber: number): string {
  if (!Number.isInteger(pullNumber) || pullNumber <= 0) {
    throw new InvalidGitArgumentError(`Invalid pull request number: ${pullNumber}`);
  }
  return `refs/pull/${pullNumber}/head`;
}

/**
 * `git log --format=... -- <path>` — full commit history touching a file, newest first.
 * Used by `whyguard trace` to reconstruct why a file/symbol looks the way it does.
 */
export function getFileHistory(repoRoot: string, filePath: string, maxCount = 50): CommitInfo[] {
  assertPathInsideRepo(repoRoot, filePath);
  if (!Number.isInteger(maxCount) || maxCount < 1) {
    throw new InvalidGitArgumentError(`Invalid maxCount: ${maxCount}`);
  }
  const format = ["%H", "%an", "%ae", "%aI", "%s", "%b"].join("%x1e");
  const output = runGit(repoRoot, [
    "log",
    `--max-count=${maxCount}`,
    `--format=${format}%x1d`,
    "--",
    filePath,
  ]);
  return output
    .split("\x1d")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      const [sha = "", authorName = "", authorEmail = "", date = "", subject = "", ...rest] =
        entry.split("\x1e");
      return {
        sha: sha.trim(),
        authorName: authorName.trim(),
        authorEmail: authorEmail.trim(),
        date: date.trim(),
        subject: subject.trim(),
        body: rest.join("\x1e").trim(),
      };
    });
}
