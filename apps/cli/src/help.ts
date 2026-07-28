import * as ui from "./ui.js";

/**
 * Help text, split into a one-screen overview and per-command detail.
 *
 * The previous single block was 70 lines, which meant the first thing anyone saw was a
 * wall they had to read in full to find the one command they wanted. `whyguard` alone now
 * fits on a screen; `whyguard help <command>` carries the depth that used to be inline.
 */

type CommandHelp = {
  name: string;
  usage: string;
  /** One line for the overview table. Fits in ~52 columns. */
  summary: string;
  /** Paragraphs and option notes for `help <command>`. */
  detail: string[];
  examples?: string[];
};

const COMMANDS: CommandHelp[] = [
  {
    name: "demo",
    usage: "demo [--scenario payments|timeouts] [--dir <path>] [--force] [--list]",
    summary: "Self-contained walkthrough. Start here",
    detail: [
      "Builds a throwaway repository whose Git history genuinely contains a decision,",
      "scans it, and arms the Git hook so your own next commit is aborted. No AWS",
      "account, no server, no GitHub App.",
      "",
      "  payments   (default) a confirmed decision blocks a plausible refactor",
      "  timeouts   the same change only warns until the decision is written down",
      "",
      "Refuses a target directory that already has files in it unless --force is",
      "passed, because the repository is rebuilt from scratch.",
    ],
    examples: ["whyguard demo", "whyguard demo --scenario timeouts", "whyguard demo --list"],
  },
  {
    name: "init",
    usage: "init [--repo <path>] [--force] [--database-url <url>] [--skip-git-hook] [--skip-kiro]",
    summary: "Wire every guardrail into a repository",
    detail: [
      "Installs the Git pre-commit hook, the Kiro PreToolUse and Stop hooks, the MCP",
      "server config, and an inactive rationale-contract template.",
      "",
      "Idempotent: it merges into existing config files and never replaces a file it",
      "does not recognize without --force.",
    ],
    examples: ["whyguard init", "whyguard init --repo ../other-project"],
  },
  {
    name: "scan",
    usage: "scan --base <ref> --head <ref> [--format json|text] [--repo <path>]",
    summary: "Analyze a Git range",
    detail: [
      "Compares two refs, detects changes that remove protected behavior, gathers",
      "evidence from the repository, and scores each finding.",
      "",
      "Exits 1 when a finding is critical, 0 otherwise, 2 on failure.",
    ],
    examples: [
      "whyguard scan --base main --head HEAD --format text",
      "whyguard scan --base HEAD~10 --head HEAD | jq '.findings[].severity'",
    ],
  },
  {
    name: "trace",
    usage: "trace <file>:<symbol> [--ref <ref>] [--format json|text] [--repo <path>]",
    summary: "What is known about a symbol, before you edit it",
    detail: [
      "Reconstructs the confirmed decision, the evidence, and the commit history for a",
      "symbol. Read-only, and the command worth reaching for first.",
    ],
    examples: ["whyguard trace src/payments/create-order.ts:createOrder --format text"],
  },
  {
    name: "verify",
    usage: "verify [--scope staged|working-tree] [--repo <path>] [--format json|text]",
    summary: "Check work that is not committed yet",
    detail: [
      "Exits 2 when protected behavior was removed, 0 otherwise. Intended callers:",
      "",
      "  git pre-commit hook   whyguard verify --scope staged",
      "  Kiro Stop hook        whyguard verify --scope working-tree",
      "",
      "Checks the result of an edit rather than asking permission first, so it still",
      "holds when an agent ignores a PreToolUse block.",
    ],
    examples: ["whyguard verify --scope staged"],
  },
  {
    name: "guard",
    usage: "guard --stdin [--repo <path>]",
    summary: "Evaluate one proposed edit read from STDIN",
    detail: [
      "Reads a GuardRequest as JSON (see @whyguard/contracts) and decides",
      "allow, warn, or block. Exits 0 on allow and warn, 2 on block with the reason",
      "on STDERR.",
    ],
  },
  {
    name: "hook",
    usage: "hook --repo <path> [--on-block ask|exit-code]",
    summary: "Same, reading a raw Kiro PreToolUse event",
    detail: [
      "Wire this directly as a .kiro/hooks PreToolUse command action.",
      "",
      "  ask        (default) emit a Kiro permissionDecision on STDOUT and exit 0, so",
      "             the IDE prompts the human. An agent can ignore an exit code; it",
      "             cannot bypass the IDE's own prompt.",
      "  exit-code  feedback on STDERR, exit 2. Use where the exit code is the gate.",
    ],
  },
  {
    name: "install-hooks",
    usage: "install-hooks [--repo <path>] [--force]",
    summary: "Install only the Git pre-commit hook",
    detail: [
      "The strongest layer: Git aborts the commit itself, so unlike the Kiro hook it",
      "cannot be ignored by an agent.",
      "",
      "Refuses to overwrite a pre-commit hook WhyGuard does not manage unless --force",
      "is passed. Honors core.hooksPath, so it installs into .husky when that is where",
      "the repository keeps its hooks.",
    ],
  },
];

const SHARED_OPTIONS: [string, string][] = [
  ["--repo <path>", "Repository root (default: current directory)"],
  ["--format json|text", "Output format (default: json)"],
  ["--force", "Allow an action that would otherwise be refused"],
  ["-h, --help", "Show help for a command"],
];

const ENVIRONMENT: [string, string][] = [
  ["WHYGUARD_SKIP=1", "Skip the Git pre-commit check for one commit"],
  ["WHYGUARD_MAX_REPO_SIZE_MB", "Largest repository a webhook scan will clone"],
  ["WHYGUARD_LLM_ENABLED", "Set to true, with AWS_REGION and BEDROCK_MODEL_ID, for"],
  ["", "model-written explanations. Off by default"],
  ["NO_COLOR", "Disable colour (also honored automatically off a TTY)"],
];

export function printOverview(stream: NodeJS.WriteStream = process.stderr): void {
  ui.blank(stream);
  stream.write(
    `  ${ui.style.heading("whyguard")}  ${ui.style.muted("reconstructs why code exists, and stops it being deleted by accident")}\n\n`,
  );

  ui.section("usage", stream);
  stream.write(`  ${ui.style.code("whyguard")} <command> [options]\n\n`);

  ui.section("commands", stream);
  const nameWidth = Math.max(...COMMANDS.map((command) => command.name.length));
  for (const command of COMMANDS) {
    stream.write(
      `  ${ui.style.code(command.name.padEnd(nameWidth))}  ${ui.style.muted(command.summary)}\n`,
    );
  }
  ui.blank(stream);

  ui.section("options", stream);
  ui.definitions(SHARED_OPTIONS, stream);
  ui.blank(stream);

  stream.write(
    `  ${ui.style.muted(`Run ${ui.style.code("whyguard help <command>")}${ui.style.muted(" for details, or ")}${ui.style.code("whyguard demo")}${ui.style.muted(" to see it work.")}`)}\n\n`,
  );
}

/** Returns false when the name is not a command, so the caller can fall back to the overview. */
export function printCommandHelp(
  name: string,
  stream: NodeJS.WriteStream = process.stdout,
): boolean {
  const command = COMMANDS.find((candidate) => candidate.name === name);
  if (!command) return false;

  ui.blank(stream);
  stream.write(`  ${ui.style.heading(`whyguard ${command.name}`)}\n`);
  stream.write(`  ${ui.style.muted(command.summary)}\n\n`);

  ui.section("usage", stream);
  stream.write(`  ${ui.style.code(`whyguard ${command.usage}`)}\n\n`);

  for (const paragraph of command.detail) {
    stream.write(paragraph ? `  ${paragraph}\n` : "\n");
  }
  ui.blank(stream);

  if (command.examples && command.examples.length > 0) {
    ui.section("examples", stream);
    for (const example of command.examples) {
      stream.write(`  ${ui.style.code(example)}\n`);
    }
    ui.blank(stream);
  }

  if (command.name === "install-hooks" || command.name === "verify") {
    ui.section("environment", stream);
    ui.definitions(ENVIRONMENT, stream);
    ui.blank(stream);
  }

  return true;
}

export function printEnvironment(stream: NodeJS.WriteStream = process.stdout): void {
  ui.section("environment", stream);
  ui.definitions(ENVIRONMENT, stream);
  ui.blank(stream);
}
