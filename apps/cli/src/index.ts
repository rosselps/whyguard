#!/usr/bin/env node
import "./warnings.js";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve, isAbsolute, relative, dirname } from "node:path";
import {
  guardChange,
  loadActiveContracts,
  loadActiveContractsWithDiagnostics,
  scanDiff,
  traceSymbol,
  verifyUncommittedWork,
  type UncommittedScope,
} from "@whyguard/application";
import { parseGuardRequest } from "@whyguard/contracts";
import {
  closeDatabase,
  openDatabase,
  resolveDatabasePath,
  saveScanReport,
  updateFindingLlmExplanation,
  upsertDecision,
} from "@whyguard/persistence-adapter";
import { createBedrockInvoker, explainFinding } from "@whyguard/llm-adapter";
import {
  buildPaymentFixture,
  stageGuardRemovalInWorkingTree,
  PAYMENT_FIXTURE_FILE,
  buildInventoryFixture,
  writeInventoryDecision,
  stageInventoryWeakeningInWorkingTree,
  INVENTORY_FIXTURE_TEST_FILE,
} from "@whyguard/test-fixtures";
import { parseFlags } from "./args.js";
import { readStdin } from "./stdin.js";
import { installGitPreCommitHook } from "./install-git-hook.js";
import { initProject } from "./init-project.js";
import {
  extractGuardCandidate,
  formatKiroAskDecision,
  toRepoRelativePath,
  type KiroPreToolUseEvent,
} from "./hook-adapter.js";

import * as ui from "./ui.js";
import { printCommandHelp, printOverview } from "./help.js";

/**
 * WhyGuard CLI entrypoint. Composes the deterministic use cases in
 * `@whyguard/application` and owns all terminal presentation — see `ui.ts` for the
 * rules that keep `--format json` free of it.
 */
function printUsageAndExit(code: number): never {
  printOverview();
  process.exit(code);
}

/**
 * Resolves DATABASE_URL to a filesystem path relative to the CLI's current
 * working directory. CLI-generated reports are persisted the same way
 * GitHub-triggered ones are, so the
 * dashboard shows both regardless of where a scan was run from.
 */
function resolveDatabaseFilePath(): string {
  const databaseUrl = process.env.DATABASE_URL?.trim() || "file:./data/whyguard.db";
  const path = resolveDatabasePath(databaseUrl);
  if (path === ":memory:" || isAbsolute(path)) return path;
  return resolve(process.cwd(), path);
}

async function runScan(flags: Record<string, string | boolean>): Promise<void> {
  const base = flags.base;
  const head = flags.head;
  const format = typeof flags.format === "string" ? flags.format : "json";
  const repoRoot = typeof flags.repo === "string" ? flags.repo : process.cwd();

  if (typeof base !== "string" || typeof head !== "string") {
    ui.failure("whyguard scan needs two refs to compare.", "Pass --base <ref> --head <ref>.");
    printUsageAndExit(1);
  }

  warnAboutInvalidContracts(repoRoot);

  if (process.env.WHYGUARD_LLM_ENABLED === "true") {
    ui.line(
      "warning",
      "WHYGUARD_LLM_ENABLED is set, but scoring is always deterministic.",
      "A model only rewords an explanation; it never changes a score or a verdict.",
      process.stderr,
    );
  }

  const asText = format === "text";
  if (asText) {
    ui.banner("scan", `${base}${ui.style.muted(" → ")}${head}`);
  }

  // Tracing the introducing commit walks history per finding, which is where the wait
  // comes from on a large repository. Spinner on stderr so a piped stdout stays clean.
  const spinner = asText ? ui.progress("Comparing refs and tracing history…") : undefined;

  try {
    const report = scanDiff({ repoRoot, base, head, source: "cli" });
    spinner?.succeed(`Analyzed ${report.findings.length} finding(s)`);

    if (asText) {
      printTextReport(report);
    } else {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    }

    const hasCritical = report.findings.some((finding) => finding.severity === "critical");
    process.exitCode = hasCritical ? 1 : 0;
    await persistScanReportBestEffort(repoRoot, report);
  } catch (error) {
    spinner?.fail("Scan failed");
    const message = error instanceof Error ? error.message : String(error);
    ui.failure(
      "whyguard scan could not complete.",
      `${message}\n    Check that both refs exist: git rev-parse ${base} ${head}`,
    );
    process.exitCode = 2;
  }
}

/**
 * Saves a completed scan report to the shared SQLite database so the dashboard
 * (Phase 5) can list CLI-generated reports alongside GitHub-triggered ones. This
 * is deliberately best-effort: a persistence failure (e.g. the database file is
 * locked or unwritable) must never change the CLI's exit code or hide the scan's
 * own JSON/text output, which is what a user piping this into another tool
 * depends on.
 */
async function persistScanReportBestEffort(
  repoRoot: string,
  report: ReturnType<typeof scanDiff>,
): Promise<void> {
  const dbPath = resolveDatabaseFilePath();
  let db: ReturnType<typeof openDatabase> | undefined;
  try {
    db = openDatabase(dbPath);
    // Cache every active rationale contract this scan saw, so a finding's
    // matchingDecisionId resolves to a real cached row (GET /decisions/:id)
    // instead of always 404ing.
    for (const contract of loadActiveContracts(repoRoot)) {
      upsertDecision(db, { contract });
    }
    saveScanReport(db, report);

    // compute a deterministic-first
    // explanation for every finding. `explainFinding` only attempts a real
    // Bedrock call when `bedrockInvoker()` returns one — see that function's
    // comment for the exact opt-in conditions.
    const invoker = bedrockInvoker();
    for (const finding of report.findings) {
      const explanation = await explainFinding(finding, { invoker });
      updateFindingLlmExplanation(db, finding.id, explanation);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ui.line("warning", "Report was not saved for the dashboard.", message, process.stderr);
  } finally {
    if (db) closeDatabase(db);
  }
}

/**
 * Builds a Bedrock invoker only when explicitly opted in via
 * `WHYGUARD_LLM_ENABLED=true` and both `AWS_REGION`/`BEDROCK_MODEL_ID` are set —
 * mirrors `apps/api/src/config.ts`'s `loadBedrockConfig`. Returns `undefined`
 * otherwise, which makes `explainFinding` always use the deterministic
 * fallback; this is the CLI's default and what every test relies on.
 */
function bedrockInvoker() {
  if (process.env.WHYGUARD_LLM_ENABLED?.trim() !== "true") return undefined;
  const region = process.env.AWS_REGION?.trim();
  const modelId = process.env.BEDROCK_MODEL_ID?.trim();
  if (!region || !modelId) return undefined;
  return createBedrockInvoker({ region, modelId });
}

function runTrace(target: string | undefined, flags: Record<string, string | boolean>): void {
  if (!target) {
    ui.failure(
      "whyguard trace needs a target.",
      "Pass <file>:<symbol>, e.g. src/payments/create-order.ts:createOrder",
    );
    printUsageAndExit(1);
  }

  const separatorIndex = target.lastIndexOf(":");
  const filePath = separatorIndex === -1 ? target : target.slice(0, separatorIndex);
  const symbol = separatorIndex === -1 ? undefined : target.slice(separatorIndex + 1);

  const format = typeof flags.format === "string" ? flags.format : "json";
  const repoRoot = typeof flags.repo === "string" ? flags.repo : process.cwd();
  const ref = typeof flags.ref === "string" ? flags.ref : "HEAD";

  warnAboutInvalidContracts(repoRoot);

  const asText = format === "text";
  if (asText) {
    ui.banner(
      "trace",
      `${filePath}${symbol ? `${ui.style.muted(" :: ")}${symbol}` : ""} ${ui.style.muted(`at ${ref}`)}`,
    );
  }
  const spinner = asText ? ui.progress("Reading history and decisions…") : undefined;

  try {
    const result = traceSymbol({ repoRoot, filePath, symbol, ref });
    spinner?.stop();

    if (asText) {
      printTraceText(result);
    } else {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    }
    process.exitCode = 0;
  } catch (error) {
    spinner?.fail("Trace failed");
    const message = error instanceof Error ? error.message : String(error);
    ui.failure(
      "whyguard trace could not complete.",
      `${message}\n    Check the path is tracked in this repository and the ref exists.`,
    );
    process.exitCode = 2;
  }
}

/** How many commits of raw history to print before it stops being readable. */
const TRACE_HISTORY_LIMIT = 12;

function printTraceText(result: ReturnType<typeof traceSymbol>): void {
  if (result.matchingDecisionId) {
    ui.line("success", `Confirmed decision: ${ui.style.code(result.matchingDecisionId)}`);
  } else {
    ui.line(
      result.reasonStatus === "known" ? "info" : "warning",
      result.reasonStatus === "known"
        ? "No recorded decision, but history explains this code"
        : "Nothing is recorded about why this code exists",
    );
  }

  if (result.protectedProperties.length > 0) {
    ui.blank();
    ui.section("protected");
    for (const property of result.protectedProperties) {
      ui.line("info", fit(property.statement, 6));
    }
  }

  if (result.evidence.length > 0) {
    ui.blank();
    ui.section("evidence");
    ui.table(
      [{ header: "strength" }, { header: "source" }],
      result.evidence.map((evidence) => [
        ui.strengthLabel(evidence.strength),
        fit(evidence.title, 20),
      ]),
    );
  }

  if (result.history.length > 0) {
    ui.blank();
    ui.section(`history · ${result.history.length} commit(s)`);
    const shown = result.history.slice(0, TRACE_HISTORY_LIMIT);
    ui.table(
      [{ header: "commit" }, { header: "date" }, { header: "subject" }],
      shown.map((commit) => [
        ui.style.muted(commit.sha.slice(0, 9)),
        ui.style.muted(commit.date.slice(0, 10)),
        fit(commit.subject, 30),
      ]),
    );
    if (result.history.length > shown.length) {
      ui.blank();
      ui.line(
        "info",
        ui.style.muted(`${result.history.length - shown.length} older commit(s) not shown`),
        "use --format json for the full history",
      );
    }
  }

  if (result.reasonStatus === "unknown") {
    ui.blank();
    ui.box(
      "review needed",
      [
        "No reliable historical reason was found.",
        "Ask the code owner before changing this symbol.",
      ],
      "warning",
    );
    ui.blank();
  } else {
    ui.summary("info", "Read this before you edit", [
      ["evidence", String(result.evidence.length)],
      ["protected properties", String(result.protectedProperties.length)],
    ]);
  }
}

/**
 * How a `block` decision reaches the caller.
 *
 * - `"exit-code"`: feedback on STDERR, exit 2. Enforced wherever the exit code is the
 *   gate — a Git `pre-commit` hook aborts the commit, CI fails the step.
 * - `"kiro-ask"`: also emits a Kiro permission decision on STDOUT and exits 0, moving
 *   the gate to the IDE's confirmation prompt. Needed because exit 2 from a
 *   `PreToolUse` hook is only advisory: two models received it and applied the edit
 *   anyway, one of them explaining afterwards that it had removed the protection.
 */
type BlockOutputMode = "exit-code" | "kiro-ask";

function applyGuardResult(
  cliRepoRoot: string | undefined,
  request: ReturnType<typeof parseGuardRequest>,
  blockOutputMode: BlockOutputMode = "exit-code",
): void {
  const repoRoot = resolve(cliRepoRoot ?? request.repoRoot ?? process.cwd());
  warnAboutInvalidContracts(repoRoot);
  const beforeContent =
    request.beforeContent !== undefined
      ? request.beforeContent
      : readCurrentFileContent(repoRoot, request.filePath);

  const result = guardChange({
    repoRoot,
    filePath: request.filePath,
    beforeContent,
    afterContent: request.afterContent,
  });

  if (result.decision === "block") {
    // STDERR always carries the human/agent-readable reason, in both modes. The framing
    // is added here; the wording is the application layer's, unchanged, so the same
    // sentences appear in a Git hook, a Check Run, and the dashboard.
    printBlockReport(result.feedback);

    if (blockOutputMode === "kiro-ask") {
      process.stdout.write(`${formatKiroAskDecision(result.feedback)}\n`);
      // Deliberately exit 0: Kiro only reads the permission decision from a
      // successful hook run. The gate here is the IDE's confirmation prompt,
      // not the exit code — see BlockOutputMode.
      process.exitCode = 0;
      return;
    }

    process.exitCode = 2;
    return;
  }

  if (result.decision === "warn") {
    ui.line("warning", fit(result.feedback, 6), undefined, process.stderr);
  }
  process.exitCode = 0;
}

function readCurrentFileContent(repoRoot: string, filePath: string): string | null {
  try {
    return readFileSync(join(repoRoot, filePath), "utf-8");
  } catch {
    return null;
  }
}

async function runGuard(flags: Record<string, string | boolean>): Promise<void> {
  if (flags.stdin !== true) {
    ui.failure(
      "whyguard guard reads its input from STDIN.",
      "Pass --stdin and pipe a GuardRequest as JSON.",
    );
    printUsageAndExit(1);
    return;
  }

  const cliRepoRoot = typeof flags.repo === "string" ? flags.repo : undefined;

  try {
    const raw = await readStdin();
    const parsed: unknown = JSON.parse(raw);
    const request = parseGuardRequest(parsed);
    applyGuardResult(cliRepoRoot, request);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ui.failure(
      "whyguard guard could not evaluate the edit, so nothing was checked.",
      `${message}\n    This is not a block.`,
    );
    // "Other non-zero exit: hook failure; do not claim the code is
    // unsafe." Use a distinct code from the block exit code (2) so callers can tell
    // a real block apart from a tooling failure.
    process.exitCode = 3;
  }
}

/**
 * Reads and translates a Kiro PreToolUse event from STDIN, resolving the file
 * path Kiro reports (typically absolute — see `toRepoRelativePath`'s comment
 * in hook-adapter.ts) to a repo-relative path before evaluating it.
 */
/**
 * Resolves `--on-block` for the `hook` command. Defaults to `"kiro-ask"`, because
 * `hook` exists specifically to be wired into Kiro, where a bare exit 2 was
 * verified not to stop an agent (see BlockOutputMode). `--on-block exit-code`
 * restores the plain exit-code contract for Git-hook/CI callers.
 */
function resolveBlockOutputMode(flags: Record<string, string | boolean>): BlockOutputMode {
  return flags["on-block"] === "exit-code" ? "exit-code" : "kiro-ask";
}

async function runHook(flags: Record<string, string | boolean>): Promise<void> {
  const cliRepoRoot = typeof flags.repo === "string" ? flags.repo : undefined;
  const repoRootForRead = resolve(cliRepoRoot ?? process.cwd());

  try {
    const raw = await readStdin();
    const event: KiroPreToolUseEvent =
      raw.trim().length > 0 ? (JSON.parse(raw) as KiroPreToolUseEvent) : {};
    const candidate = extractGuardCandidate(event, (filePath) =>
      readCurrentFileContent(repoRootForRead, toRepoRelativePath(repoRootForRead, filePath)),
    );

    if (!candidate) {
      // Not a file-write-shaped tool call; nothing for WhyGuard to evaluate.
      process.exitCode = 0;
      return;
    }

    const request = parseGuardRequest({
      repoRoot: cliRepoRoot,
      filePath: toRepoRelativePath(repoRootForRead, candidate.filePath),
      afterContent: candidate.afterContent,
    });
    applyGuardResult(cliRepoRoot, request, resolveBlockOutputMode(flags));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ui.failure(
      "whyguard hook could not evaluate the edit, so nothing was checked.",
      `${message}\n    This is not a block.`,
    );
    process.exitCode = 3;
  }
}

/**
 * `whyguard verify` — checks work that is not committed yet. This is the enforcement layer behind the
 * `PreToolUse` hook: it inspects the *result* of an agent's edits rather than asking
 * permission beforehand, so it holds even when a `PreToolUse` block was ignored.
 *
 * Exit codes follow the contract (0 = allow/warn, 2 = block, 3 = failure).
 * Two intended callers:
 *
 *   git pre-commit hook whyguard verify --scope staged
 *   Kiro Stop hook whyguard verify --scope working-tree
 *
 * In the `pre-commit` case Git enforces the exit code itself by aborting the commit,
 * which is what makes this layer — unlike `PreToolUse` — impossible for a model to
 * bypass.
 */
function runVerify(flags: Record<string, string | boolean>): void {
  const repoRoot = resolve(typeof flags.repo === "string" ? flags.repo : process.cwd());
  const scope: UncommittedScope = flags.scope === "staged" ? "staged" : "working-tree";
  warnAboutInvalidContracts(repoRoot);

  // No banner or spinner here on purpose: `verify` is what a Git hook runs on every
  // commit, and decorating a check that usually says nothing would make every commit
  // noisier. It speaks up only when it has something to say.
  try {
    const result = verifyUncommittedWork({ repoRoot, scope });

    if (flags.format === "json") {
      process.stdout.write(
        `${JSON.stringify(
          {
            decision: result.decision,
            scope,
            analyzedFilePaths: result.analyzedFilePaths,
            files: result.files.map((file) => ({
              filePath: file.filePath,
              decision: file.decision,
              findings: file.findings.map((entry) => entry.finding),
            })),
          },
          null,
          2,
        )}\n`,
      );
    } else if (result.decision === "block") {
      printBlockReport(result.report);
    } else {
      printQuietVerdict(result);
    }

    process.exitCode = result.decision === "block" ? 2 : 0;
  } catch (error) {
    // A verification failure must not masquerade as a block: exit 3, and say that the
    // check could not run rather than that the code is unsafe.
    const message = error instanceof Error ? error.message : String(error);
    ui.failure(
      "whyguard verify could not run, so nothing was checked.",
      `${message}\n    This is not a block. Fix the error above and commit again.`,
    );
    process.exitCode = 3;
  }
}

/**
 * A block is the one moment the CLI must be impossible to skim past, so the reason goes
 * in a framed block with the next step underneath.
 *
 * The report text itself comes from the application layer unchanged — only the framing is
 * added here, so the same words appear in a Git hook, a Check Run, and the dashboard.
 */
function printBlockReport(report: string): void {
  const lines = report.split("\n").filter((line) => line.trim().length > 0);
  const [headline, ...rest] = lines;

  ui.blank(process.stderr);
  ui.box(
    "blocked",
    [ui.style.critical(headline ?? "Protected historical behavior was removed")],
    "danger",
    process.stderr,
  );
  ui.blank(process.stderr);
  for (const detail of rest) {
    process.stderr.write(`  ${detail}\n`);
  }
  ui.blank(process.stderr);
  ui.paragraph(
    ui.style.muted(`Deliberate override: ${ui.style.code("WHYGUARD_SKIP=1 git commit ...")}`),
    process.stderr,
  );
  ui.blank(process.stderr);
}

/** The common case: nothing blocks. One line, or one line plus a count of warnings. */
function printQuietVerdict(result: ReturnType<typeof verifyUncommittedWork>): void {
  const warnings = result.files.reduce((total, file) => total + file.findings.length, 0);
  if (warnings === 0) {
    ui.line("success", `No historical-decision risk in ${result.analyzedFilePaths.length} file(s)`);
    return;
  }
  ui.line(
    "warning",
    `${warnings} non-blocking finding(s) in ${result.analyzedFilePaths.length} file(s)`,
    'run "whyguard verify --format json" for the detail',
  );
}

/**
 * `whyguard init` — wires every guardrail into a target repository in one command.
 *
 * The summary it prints deliberately states what each layer *guarantees*, not just
 * that it was installed. Treating the layers as equivalent is the easiest way to end
 * up with a false sense of safety: the Git hook is enforced by Git, while the Kiro
 * hook depends on the IDE prompting a human.
 */
function runInit(flags: Record<string, string | boolean>): void {
  const target = typeof flags.repo === "string" ? flags.repo : process.cwd();

  try {
    const result = initProject(target, {
      force: flags.force === true,
      databaseUrl: typeof flags["database-url"] === "string" ? flags["database-url"] : undefined,
      skipGitHook: flags["skip-git-hook"] === true,
      skipKiro: flags["skip-kiro"] === true,
    });

    const { assessment } = result;

    ui.banner("init", assessment.repoRoot);
    ui.definitions([
      ["commits", String(assessment.commitCount)],
      ["analyzable files", `${assessment.analyzableFileCount} ${ui.style.muted("TS/JS")}`],
    ]);
    ui.blank();

    ui.section("installed");
    if (result.gitHook) {
      const { action, hookPath } = result.gitHook;
      if (action === "skipped-foreign-hook") {
        ui.line(
          "warning",
          `Git pre-commit hook left untouched ${ui.style.muted(hookPath)}`,
          "An existing hook WhyGuard does not manage. Chain it, or re-run with --force.",
        );
      } else {
        ui.line("success", `Git pre-commit hook ${ui.style.muted(`(${action})`)}`, hookPath);
      }
    }
    for (const step of result.steps) {
      const status = step.outcome.startsWith("skipped") ? "warning" : "success";
      ui.line(status, `${step.filePath}  ${ui.style.muted(`(${step.outcome})`)}`, step.note);
    }

    if (assessment.warnings.length > 0) {
      ui.blank();
      ui.section("worth knowing");
      for (const warning of assessment.warnings) {
        ui.line("info", fit(warning, 6));
      }
    }

    // Stating what each layer *guarantees* rather than that it was installed. Treating
    // them as equivalent is the easiest way to end up with a false sense of safety.
    ui.blank();
    ui.section("what each layer guarantees");
    ui.table(
      [{ header: "layer" }, { header: "enforced by" }, { header: "bypassable" }],
      [
        ["Git pre-commit", "Git aborts the commit", ui.style.success("no")],
        ["GitHub PR Check", "GitHub, server-side", ui.style.success("no")],
        ["Kiro PreToolUse", "the IDE's prompt", ui.style.warning("it is a prompt")],
        ["Kiro Stop", ui.style.muted("nobody — it reports"), ui.style.warning("not a gate")],
      ],
    );

    ui.blank();
    ui.box(
      "next step",
      [
        "WhyGuard warns until a decision is written down, and blocks after.",
        "",
        `  ${ui.style.code(".whyguard/decisions/EXAMPLE.yml")}  copy it, fill it in,`,
        `  ${" ".repeat(31)}  set status to active`,
      ],
      "neutral",
    );
    ui.blank();

    process.exitCode = 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ui.failure(
      "whyguard init could not finish.",
      `${message}\n    Nothing partial was left behind; fix the cause and run it again.`,
    );
    process.exitCode = 1;
  }
}

/**
 * `whyguard install-hooks` — installs the Git `pre-commit` guard described in
 * `install-git-hook.ts`. This is the only WhyGuard layer whose block cannot be
 * ignored by an agent, because Git itself aborts the commit.
 */
function runInstallHooks(flags: Record<string, string | boolean>): void {
  const repoRoot = resolve(typeof flags.repo === "string" ? flags.repo : process.cwd());

  try {
    const result = installGitPreCommitHook(repoRoot, { force: flags.force === true });

    if (result.action === "skipped-foreign-hook") {
      ui.failure(
        "An existing pre-commit hook was left untouched.",
        `${result.hookPath}\n` +
          `    Chain WhyGuard from it:  node "${result.cliEntrypoint}" verify --scope staged\n` +
          `    Or replace it:           whyguard install-hooks --force`,
      );
      process.exitCode = 1;
      return;
    }

    ui.blank();
    ui.line("success", `Git pre-commit hook ${result.action}`, result.hookPath);
    ui.blank();
    ui.paragraph(
      ui.style.muted("A commit that removes protected historical behavior is now aborted by Git."),
    );
    ui.paragraph(ui.style.muted(`Override: ${ui.style.code("WHYGUARD_SKIP=1 git commit ...")}`));
    ui.blank();
    process.exitCode = 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ui.failure(
      "whyguard install-hooks could not write the hook.",
      `${message}\n    Check that this is a Git repository and the hooks directory is writable.`,
    );
    process.exitCode = 1;
  }
}

type DemoScenario = {
  name: string;
  headline: string;
  /** One-line outcome, so `--list` tells the reader what they will learn, not just a name. */
  teaches: string;
  defaultDir: string;
  run: (target: string) => void;
};

const DEMO_SCENARIOS: DemoScenario[] = [
  {
    name: "payments",
    headline: "A confirmed decision stops a plausible-looking simplification.",
    teaches: "detection, evidence from real Git history, and a Git commit being aborted",
    defaultDir: "whyguard-demo",
    run: runPaymentsScenario,
  },
  {
    name: "timeouts",
    headline: "The same change warns until somebody writes the decision down.",
    teaches: "why an undocumented decision cannot block, and what writing one changes",
    defaultDir: "whyguard-demo-timeouts",
    run: runTimeoutsScenario,
  },
];

/**
 * The zero-configuration entry point: see the whole thesis without a GitHub App, an AWS
 * account, an API server, or a repository of your own.
 *
 * Two scenarios rather than one, because a demo that always blocks teaches the wrong
 * lesson. `payments` shows enforcement; `timeouts` shows the boundary — a change WhyGuard
 * detects and explains but refuses to block, because nobody recorded that the behavior
 * matters. Together they make clear that a rationale contract is the input the tool needs.
 *
 * Does not persist to the shared database: a demo should not leave a `data/whyguard.db`
 * in whatever directory the reader happened to be standing in.
 */
function runDemo(flags: Record<string, string | boolean>): void {
  if (flags.list === true) {
    printDemoScenarios();
    process.exitCode = 0;
    return;
  }

  const requestedName = typeof flags.scenario === "string" ? flags.scenario : "payments";
  const scenario = DEMO_SCENARIOS.find((candidate) => candidate.name === requestedName);
  if (!scenario) {
    ui.failure(
      `There is no demo scenario called "${requestedName}".`,
      `Available: ${DEMO_SCENARIOS.map((candidate) => candidate.name).join(", ")}`,
    );
    printDemoScenarios(process.stderr);
    process.exitCode = 1;
    return;
  }

  const requestedDir = typeof flags.dir === "string" ? flags.dir : scenario.defaultDir;
  const target = resolve(process.cwd(), requestedDir);

  // The fixture builders delete their target directory to guarantee a clean history.
  // That is fine for a throwaway path and catastrophic for a real one, so refuse a
  // non-empty directory rather than trusting the reader typed --dir carefully.
  if (existsSync(target) && readdirSync(target).length > 0 && flags.force !== true) {
    ui.failure(
      "That directory already has files in it, and the demo rebuilds from scratch.",
      `${target}\n` +
        `    Choose an empty path with --dir <path>, or pass --force if it is disposable.`,
    );
    process.exitCode = 1;
    return;
  }

  try {
    ui.banner(`demo ${ui.style.muted("·")} ${scenario.name}`, scenario.headline);
    scenario.run(target);
    process.exitCode = 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ui.failure("whyguard demo could not finish.", message);
    process.exitCode = 1;
  }
}

function printDemoScenarios(stream: NodeJS.WriteStream = process.stdout): void {
  ui.blank(stream);
  ui.section("demo scenarios", stream);
  ui.table(
    [{ header: "name" }, { header: "shows" }],
    DEMO_SCENARIOS.map((scenario) => [ui.style.code(scenario.name), scenario.headline]),
    stream,
  );
  ui.blank(stream);
  for (const scenario of DEMO_SCENARIOS) {
    ui.line("step", `${scenario.name}: ${ui.style.muted(scenario.teaches)}`, undefined, stream);
  }
  ui.blank(stream);
  stream.write(`  ${ui.style.code("whyguard demo --scenario <name>")}\n\n`);
}

/** Fails loudly if a scenario stops demonstrating what it claims to demonstrate. */
function assertFindings(report: ReturnType<typeof scanDiff>, expectation: string): void {
  if (report.findings.length === 0) {
    throw new Error(
      `expected ${expectation} but the scan produced no findings. This is a bug in ` +
        "WhyGuard, not in your setup — please open an issue.",
    );
  }
}

/** Numbered step heading, so a walkthrough reads as a sequence rather than a wall. */
function step(current: number, total: number, title: string): void {
  process.stdout.write(`  ${ui.style.muted(`${current}/${total}`)} ${ui.style.heading(title)}\n`);
}

/** "Run these yourself" block: commands the reader is expected to copy, plus what happens. */
function nextCommands(entries: [command: string, effect: string][]): void {
  const commandWidth = Math.max(...entries.map(([command]) => command.length));
  for (const [command, effect] of entries) {
    const padded = effect ? command.padEnd(commandWidth) : command;
    process.stdout.write(
      `  ${ui.style.code(padded)}${effect ? `  ${ui.style.muted(effect)}` : ""}\n`,
    );
  }
}

function runPaymentsScenario(target: string): void {
  step(1, 3, "Building a repository with a real decision in its history");
  const fixture = buildPaymentFixture(target);
  ui.definitions([
    ["path", fixture.repoRoot],
    [
      fixture.safeSha.slice(0, 9),
      "adds an idempotency guard, message cites issue #481 and PR #493",
    ],
    [fixture.unsafeSha.slice(0, 9), '"Simplify createOrder by removing redundant duplicate check"'],
    ["decision", ".whyguard/decisions/payment-idempotency.yml"],
  ]);
  ui.blank();

  step(2, 3, "Scanning that change the way a reviewer never has time to");
  const report = scanDiff({
    repoRoot: fixture.repoRoot,
    base: fixture.safeSha,
    head: fixture.unsafeSha,
    source: "cli",
  });
  printTextReport(report);
  assertFindings(report, "the removed idempotency guard to be detected");

  step(3, 3, "Arming the layer that cannot be talked out of it");
  const changedFile = stageGuardRemovalInWorkingTree(fixture.repoRoot, fixture.safeSha);
  const hook = installGitPreCommitHook(fixture.repoRoot, { force: true });
  ui.line("success", `Git pre-commit hook ${hook.action}`, hook.hookPath);
  ui.line(
    "info",
    `The guard removal is uncommitted in ${ui.style.code(relative(fixture.repoRoot, changedFile))}`,
  );
  ui.blank();

  ui.section("now see it hold");
  nextCommands([
    [`cd ${relative(process.cwd(), fixture.repoRoot) || "."}`, ""],
    ["git add -A", ""],
    ['git commit -m "Simplify createOrder"', "Git aborts this commit"],
  ]);
  ui.blank();

  ui.section("also worth trying");
  nextCommands([
    ["whyguard verify --scope working-tree", "what an agent just did to you"],
    [
      `whyguard trace ${PAYMENT_FIXTURE_FILE.replace(/\\/g, "/")}:createOrder --format text`,
      "what is known before you edit",
    ],
    ['WHYGUARD_SKIP=1 git commit -m "..."', "the override, deliberate and visible"],
    ["whyguard demo --scenario timeouts", "the case where it does NOT block"],
  ]);

  ui.summary("info", "No network and no model were involved", [
    ["deterministic", "100%"],
    [report.findings.length === 1 ? "finding" : "findings", String(report.findings.length)],
  ]);
}

/**
 * The scenario for the question every honest evaluation reaches: "so does it block
 * everything?" No. It blocks what a human confirmed matters.
 *
 * Same repository, same code change, scanned twice — the only difference between the
 * two scans is whether `.whyguard/decisions/` contains the decision. That is the
 * clearest way to show that WhyGuard's `strong` evidence comes from a person, not from
 * a heuristic, and that the block rule refuses to fire without it.
 */
function runTimeoutsScenario(target: string): void {
  step(1, 4, "Building a repository where nobody wrote the decision down");
  const fixture = buildInventoryFixture(target);
  ui.definitions([
    ["path", fixture.repoRoot],
    [fixture.safeSha.slice(0, 9), 'retries the sync 3x with a 30s timeout, "fixes #212"'],
    [fixture.unsafeSha.slice(0, 9), '"Speed up inventory sync by trimming retries and timeout"'],
    ["decision", ui.style.warning("none — the normal state of most repositories")],
  ]);
  ui.blank();

  step(2, 4, "Scanning it. WhyGuard knows something, but not enough");
  const before = scanDiff({
    repoRoot: fixture.repoRoot,
    base: fixture.safeSha,
    head: fixture.unsafeSha,
    source: "cli",
  });
  printTextReport(before, { limit: 1 });
  assertFindings(before, "the weakened retry and timeout to be detected");

  const worstBefore = Math.max(...before.findings.map((finding) => finding.riskScore));
  ui.box(
    "not blocked",
    [
      `Highest risk ${ui.style.warning(String(worstBefore))}, and no evidence is stronger than medium.`,
      "A commit message that mentions an issue is a hint, not a decision,",
      "and WhyGuard will not refuse a change on a hint.",
    ],
    "warning",
  );
  ui.blank();

  step(3, 4, "Recording the decision, the way a human would");
  const decisionPath = writeInventoryDecision(fixture.repoRoot);
  ui.line("success", ui.style.code(relative(fixture.repoRoot, decisionPath)));

  const after = scanDiff({
    repoRoot: fixture.repoRoot,
    base: fixture.safeSha,
    head: fixture.unsafeSha,
    source: "cli",
  });
  printTextReport(after, { limit: 1 });
  const worstAfter = Math.max(...after.findings.map((finding) => finding.riskScore));
  ui.box(
    "same code, different verdict",
    [
      `Risk ${ui.style.warning(String(worstBefore))} ${ui.symbol.arrow} ${ui.style.critical(String(worstAfter))}, evidence is now strong, and the`,
      "protected properties are the ones the contract states rather than",
      "ones WhyGuard guessed.",
    ],
    "danger",
  );
  ui.blank();

  step(4, 4, "Arming the Git hook against the recorded decision");
  const changedFile = stageInventoryWeakeningInWorkingTree(fixture.repoRoot, fixture.safeSha);
  const hook = installGitPreCommitHook(fixture.repoRoot, { force: true });
  ui.line("success", `Git pre-commit hook ${hook.action}`, hook.hookPath);
  ui.line(
    "info",
    `The weakening is uncommitted in ${ui.style.code(relative(fixture.repoRoot, changedFile))}`,
  );
  ui.blank();

  const testDir = dirname(INVENTORY_FIXTURE_TEST_FILE).replace(/\\/g, "/");
  const testFile = INVENTORY_FIXTURE_TEST_FILE.replace(/\\/g, "/");

  ui.section("try both halves of the lesson");
  nextCommands([
    [`cd ${relative(process.cwd(), fixture.repoRoot) || "."}`, ""],
    ['git add -A && git commit -m "Speed up sync"', "Git aborts this commit"],
    [`mkdir -p ${testDir} && touch ${testFile}`, "the escape route the block offers"],
    ['git add -A && git commit -m "Speed up sync"', "allowed: required_tests now exists"],
  ]);

  ui.summary("info", "That last step is the whole contract between you and the tool", [
    ["WhyGuard runs your test", ui.style.error("never")],
    ["it trusts the decision file", ui.style.success("always")],
  ]);
}

/**
 * Warns about decision files that exist but failed to load. Called by every command that
 * consults contracts: a file rejected by the schema leaves the repository unprotected
 * while looking exactly like one that is protected.
 *
 * STDERR so `--format json` stays machine-readable, and never a non-zero exit — an
 * unrelated broken file must not stop the scan the user asked for.
 */
function warnAboutInvalidContracts(repoRoot: string): void {
  const { invalid } = loadActiveContractsWithDiagnostics(repoRoot);
  if (invalid.length === 0) return;

  ui.blank(process.stderr);
  ui.box(
    `${invalid.length} decision file(s) not loaded`,
    [ui.style.warning("Behavior these were meant to protect is NOT protected.")],
    "warning",
    process.stderr,
  );
  ui.blank(process.stderr);
  for (const entry of invalid) {
    ui.line("error", entry.file, entry.error, process.stderr);
  }
  ui.blank(process.stderr);
  ui.paragraph(
    ui.style.muted(
      "Usually an unquoted colon in a list item, which YAML reads as a key. Quote the line.",
    ),
    process.stderr,
  );
  ui.blank(process.stderr);
}

/** Truncates a sentence to one terminal line so a paragraph never wraps mid-column. */
function fit(text: string, reserved = 4): string {
  const limit = ui.width() - reserved;
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

/**
 * Renders one finding: identity line, scores as an aligned block, then the reason and its
 * evidence. Ordered so a reader can stop after the first two lines and still know whether
 * they need to care.
 */
function printFinding(finding: ReturnType<typeof scanDiff>["findings"][number]): void {
  const location = finding.change.symbol
    ? `${finding.change.filePath} ${ui.style.muted("::")} ${ui.style.heading(finding.change.symbol)}`
    : ui.style.heading(finding.change.filePath);

  ui.blank();
  process.stdout.write(`  ${ui.severityLabel(finding.severity)} ${location}\n`);
  ui.definitions([
    ["change", finding.change.kind],
    ["risk", `${finding.riskScore}${ui.style.muted(" / 100")}`],
    ["confidence", `${finding.confidenceScore}${ui.style.muted(" / 100")}`],
    [
      "reason",
      finding.reasonStatus === "known" ? ui.style.success("known") : ui.style.warning("unknown"),
    ],
  ]);
  ui.blank();
  ui.paragraph(ui.style.muted(fit(finding.explanation)));

  if (finding.protectedProperties.length > 0) {
    ui.blank();
    ui.section("protected");
    for (const property of finding.protectedProperties) {
      ui.line("info", fit(property.statement, 6));
    }
  }

  if (finding.evidence.length > 0) {
    ui.blank();
    ui.section("evidence");
    ui.table(
      [{ header: "strength" }, { header: "source" }],
      finding.evidence.map((evidence) => [
        ui.strengthLabel(evidence.strength),
        fit(evidence.title, 20),
      ]),
    );
  }

  ui.blank();
  ui.line("step", ui.style.muted(fit(finding.recommendation, 6)));
}

function printTextReport(
  report: ReturnType<typeof scanDiff>,
  options: { limit?: number } = {},
): void {
  const ordered =
    options.limit === undefined
      ? report.findings
      : [...report.findings].sort((a, b) => b.riskScore - a.riskScore).slice(0, options.limit);

  for (const finding of ordered) {
    printFinding(finding);
  }

  const hidden = report.findings.length - ordered.length;
  if (hidden > 0) {
    ui.blank();
    ui.line(
      "info",
      ui.style.muted(`${hidden} more finding(s) on the same symbol`),
      'run "whyguard scan" for the full report',
    );
  }

  printFindingSummary(report.findings);
}

/** Closing counts for a scan-like command, so the last line answers "how bad is it?". */
function printFindingSummary(findings: ReturnType<typeof scanDiff>["findings"]): void {
  if (findings.length === 0) {
    ui.summary("success", "No historical-decision risk found");
    return;
  }

  const count = (severity: string): number =>
    findings.filter((finding) => finding.severity === severity).length;
  const critical = count("critical");
  const stats: [string, string][] = [
    ["critical", ui.style.critical(String(critical))],
    ["high", ui.style.error(String(count("high")))],
    ["medium", ui.style.warning(String(count("medium")))],
    ["low", ui.style.muted(String(count("low")))],
    ["unknown reason", String(findings.filter((f) => f.reasonStatus === "unknown").length)],
  ];

  ui.summary(
    critical > 0 ? "error" : "warning",
    findings.length === 1 ? "1 finding needs a look" : `${findings.length} findings need a look`,
    stats,
  );
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);

  // `help <command>` and `<command> --help` both reach the same per-command page, because
  // guessing which form a CLI wants is not a puzzle anyone should have to solve.
  if (command === "help" || command === "--help" || command === "-h") {
    const topic = rest[0];
    if (topic && printCommandHelp(topic)) {
      process.exitCode = 0;
      return;
    }
    printOverview(process.stdout);
    process.exitCode = 0;
    return;
  }
  if (command && (rest.includes("--help") || rest.includes("-h"))) {
    if (printCommandHelp(command)) {
      process.exitCode = 0;
      return;
    }
  }

  switch (command) {
    case "demo": {
      const flags = parseFlags(rest);
      runDemo(flags);
      break;
    }
    case "scan": {
      const flags = parseFlags(rest);
      await runScan(flags);
      break;
    }
    case "trace": {
      const [target, ...traceRest] = rest;
      const flags = parseFlags(traceRest);
      runTrace(target, flags);
      break;
    }
    case "guard": {
      const flags = parseFlags(rest);
      await runGuard(flags);
      break;
    }
    case "hook": {
      const flags = parseFlags(rest);
      await runHook(flags);
      break;
    }
    case "verify": {
      const flags = parseFlags(rest);
      runVerify(flags);
      break;
    }
    case "install-hooks": {
      const flags = parseFlags(rest);
      runInstallHooks(flags);
      break;
    }
    case "init": {
      const flags = parseFlags(rest);
      runInit(flags);
      break;
    }
    default:
      printUsageAndExit(command ? 1 : 0);
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`whyguard failed: ${message}\n`);
  process.exitCode = 3;
});
