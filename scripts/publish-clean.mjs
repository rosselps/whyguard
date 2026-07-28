#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Exports the repository as a single-commit copy, and optionally publishes it to GitHub.
 *
 * The export is produced with `git archive HEAD`, which emits exactly the tracked files at
 * HEAD. That is the load-bearing choice: copying the directory would drag in `.env`,
 * `node_modules`, `data/`, `.tmp/` and the local `.git`, and a manual exclude list would
 * rot the first time someone added a new one. If it is not committed, it is not exported.
 *
 * Usage:
 *   node scripts/publish-clean.mjs                 prepare only, into ../whyguard-public
 *   node scripts/publish-clean.mjs --push          also create the GitHub repo and push
 *   node scripts/publish-clean.mjs --dir <path> --repo <owner/name> --force
 *
 * The commit author defaults to the author of HEAD; override with --name and --email.
 */

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index !== -1 && args[index + 1] ? args[index + 1] : fallback;
};

const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
  encoding: "utf-8",
}).trim();
const target = resolve(repoRoot, value("dir", "../whyguard-public"));
const repoSlug = value("repo", "rosselps/whyguard");
const force = flag("force");

const run = (command, commandArgs, cwd = repoRoot) =>
  execFileSync(command, commandArgs, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });

function step(text) {
  process.stdout.write(`\n  ${text}\n`);
}

// A dirty tree would silently publish a different set of files than the local HEAD.
const dirty = run("git", ["status", "--porcelain"]).trim();
if (dirty) {
  process.stderr.write(
    "\n  Working tree is not clean. Commit or stash first — the export is taken from HEAD,\n" +
      "  so uncommitted work would be silently left out of what gets published.\n\n",
  );
  process.exit(1);
}

if (existsSync(target) && readdirSync(target).length > 0) {
  if (!force) {
    process.stderr.write(
      `\n  ${target} already has files in it.\n` +
        "  Pass --force to replace it, or --dir <path> to choose somewhere else.\n\n",
    );
    process.exit(1);
  }
  rmSync(target, { recursive: true, force: true });
}

step(`Exporting tracked files at HEAD to ${target}`);
mkdirSync(target, { recursive: true });
const staging = mkdtempSync(join(tmpdir(), "whyguard-export-"));
const archive = join(staging, "export.tar");
try {
  run("git", ["archive", "--format=tar", "-o", archive, "HEAD"]);
  run("tar", ["-xf", archive, "-C", target]);
} finally {
  rmSync(staging, { recursive: true, force: true });
}

const fileCount = run("git", ["ls-files"]).trim().split("\n").length;
process.stdout.write(`  ${fileCount} file(s), no history, no .git\n`);

// The export gets a brand new `.git`, so it inherits none of this repository's config. When the
// identity is set per-repository rather than globally there is nothing for git to auto-detect,
// and the commit fails. Carry over the author of HEAD, which is by definition already valid here.
const author = {
  name: value("name", run("git", ["log", "-1", "--format=%an"]).trim()),
  email: value("email", run("git", ["log", "-1", "--format=%ae"]).trim()),
};

/**
 * The rest of the team, as `Co-authored-by` trailers on the single commit.
 *
 * A commit has exactly one author, and this mirror has exactly one commit, so without
 * trailers the published repository would credit one person for the work of five.
 * GitHub reads `Co-authored-by` when it builds the contributor list, so each address
 * here has to be one attached to that person's GitHub account — an address GitHub does
 * not recognise still renders in the commit message but never becomes a contributor.
 */
const COAUTHORS = [
  { name: "Marco Chumbes", email: "markitos02chum@gmail.com" },
  { name: "José Huarcaya", email: "josemariahuarcaya2002@outlook.es" },
  { name: "Jhory Valvidia", email: "wifi.arzuz@gmail.com" },
];

const commitMessage = [
  "feat: WhyGuard — reconstruct why code exists and stop it being deleted by accident",
  "",
  ...COAUTHORS.filter((person) => person.email !== author.email).map(
    (person) => `Co-authored-by: ${person.name} <${person.email}>`,
  ),
].join("\n");
if (!author.name || !author.email) {
  process.stderr.write(
    "\n  Could not determine an author for the first commit.\n" +
      "  Pass --name <name> --email <email>.\n\n",
  );
  process.exit(1);
}

step("Creating the first commit");
process.stdout.write(`  authored as ${author.name} <${author.email}>\n`);
for (const person of COAUTHORS) {
  if (person.email !== author.email) {
    process.stdout.write(`  co-authored by ${person.name} <${person.email}>\n`);
  }
}
run("git", ["init", "--initial-branch=main"], target);
run("git", ["add", "-A"], target);
run(
  "git",
  [
    "-c",
    `user.name=${author.name}`,
    "-c",
    `user.email=${author.email}`,
    "commit",
    "-m",
    commitMessage,
  ],
  target,
);

const commits = run("git", ["rev-list", "--count", "HEAD"], target).trim();
if (commits !== "1") {
  process.stderr.write(`\n  Expected exactly 1 commit, found ${commits}. Stopping.\n\n`);
  process.exit(1);
}
process.stdout.write("  1 commit\n");

if (!flag("push")) {
  process.stdout.write(
    `\n  Ready. Review it, then publish with:\n` +
      `    node scripts/publish-clean.mjs --push --force\n` +
      `  or by hand:\n` +
      `    cd ${target} && gh repo create ${repoSlug} --public --source=. --remote=origin --push\n\n`,
  );
  process.exit(0);
}

/** True when the repository already exists on GitHub. */
function repositoryExists() {
  try {
    run("gh", ["repo", "view", repoSlug, "--json", "name"], target);
    return true;
  } catch {
    return false;
  }
}

step(`Publishing to github.com/${repoSlug}`);
try {
  if (repositoryExists()) {
    // The published repository is a generated single-commit mirror, so every update
    // replaces that commit. Force is the normal path here, not a rescue: there is no
    // history on the remote to lose, and requiring --force keeps it deliberate.
    if (!force) {
      process.stderr.write(
        `\n  github.com/${repoSlug} already exists. Updating it replaces its single\n` +
          "  commit. Re-run with --force if that is what you want.\n\n",
      );
      process.exit(1);
    }
    process.stdout.write("  repository exists, replacing its single commit\n");
    run("git", ["remote", "add", "origin", `https://github.com/${repoSlug}.git`], target);
    run("git", ["push", "--force", "-u", "origin", "main"], target);
  } else {
    run(
      "gh",
      [
        "repo",
        "create",
        repoSlug,
        "--public",
        "--source=.",
        "--remote=origin",
        "--push",
        "--description",
        "Reconstructs why code exists and stops humans or agents from erasing that protection by accident.",
      ],
      target,
    );
  }
  process.stdout.write(`  https://github.com/${repoSlug}\n\n`);
} catch (error) {
  const message = error.stderr?.toString() ?? error.message;
  process.stderr.write(
    `\n  gh repo create failed:\n  ${message.trim()}\n\n` +
      `  If the repository already exists, push into it instead:\n` +
      `    cd ${target}\n` +
      `    git remote add origin https://github.com/${repoSlug}.git\n` +
      `    git push -u origin main\n\n`,
  );
  process.exit(1);
}
