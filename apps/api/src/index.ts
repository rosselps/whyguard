#!/usr/bin/env node
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join, dirname, isAbsolute } from "node:path";
import { openDatabase, resolveDatabasePath } from "@whyguard/persistence-adapter";
import { createBedrockInvoker } from "@whyguard/llm-adapter";
import { sweepStaleWorkspaces } from "@whyguard/application";
import { loadConfig } from "./config.js";
import { createServer } from "./server.js";
import { logInfo } from "./logger.js";

/**
 * apps/api entrypoint — the GitHub webhook receiver.
 */

/**
 * Loads the monorepo-root `.env` file into process.env, regardless of the
 * process's current working directory (e.g. when started via
 * `pnpm --filter @whyguard/api dev`, cwd is `apps/api`, not the repo root).
 * Uses Node's built-in `process.loadEnvFile` (Node >= 20.6) instead of adding a
 * `dotenv` dependency. Silently does nothing if no `.env` is found — real
 * deployments are expected to provide these variables via the process
 * environment directly, not a file.
 */
function loadRootEnvFile(): void {
  const here = dirname(fileURLToPath(import.meta.url));
  // apps/api/src -> apps/api -> apps -> <repo root>
  const repoRoot = join(here, "..", "..", "..");
  const envPath = join(repoRoot, ".env");
  if (existsSync(envPath)) {
    process.loadEnvFile(envPath);
  }
}

/**
 * Resolves the DATABASE_URL to an absolute path relative to the repository root,
 * regardless of the process's current working directory — mirrors
 * `loadRootEnvFile`'s reasoning. `:memory:` is passed through unchanged (useful
 * for smoke-testing without touching disk).
 */
function resolveDatabaseFilePath(databaseUrl: string): string {
  const path = resolveDatabasePath(databaseUrl);
  if (path === ":memory:" || isAbsolute(path)) return path;
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = join(here, "..", "..", "..");
  return join(repoRoot, path);
}

function main(): void {
  loadRootEnvFile();
  const config = loadConfig();

  // Confirm what actually loaded, without ever printing a secret value — this is
  // the fastest way to tell "wrong/missing.env" apart from "webhook never
  // arrived" when something isn't working.
  logInfo("Configuration loaded", {
    githubAppId: config.githubCredentials.appId,
    webhookSecretLength: config.githubWebhookSecret.length,
    privateKeyLooksValid: config.githubCredentials.privateKey.includes("PRIVATE KEY"),
    port: config.port,
  });

  const dbPath = resolveDatabaseFilePath(config.databaseUrl);
  const db = openDatabase(dbPath);
  logInfo("Database opened", { path: dbPath });

  const bedrockInvoker = config.bedrock ? createBedrockInvoker(config.bedrock) : undefined;
  logInfo("LLM explanation mode", { source: bedrockInvoker ? "bedrock" : "fallback" });

  // Reclaim clones abandoned by a previous process that died mid-scan. WhyGuard clones
  // full history, so on a small instance a few orphaned workspaces are enough to fill
  // the disk and turn every later scan into an opaque Git failure.
  const sweep = sweepStaleWorkspaces(config.tempRoot ?? tmpdir());
  if (sweep.removed.length > 0 || sweep.failed.length > 0) {
    logInfo("Stale scan workspaces cleaned up", {
      removed: sweep.removed.length,
      failed: sweep.failed.length,
    });
  }

  const app = createServer({
    credentials: config.githubCredentials,
    webhookSecret: config.githubWebhookSecret,
    tempRoot: config.tempRoot,
    maxRepositorySizeKb: config.maxRepositorySizeKb,
    db,
    bedrockInvoker,
    apiToken: config.apiToken,
    publicRepositories: config.publicRepositories,
    dashboardOrigins: config.dashboardOrigins.length > 0 ? config.dashboardOrigins : undefined,
  });

  app.listen(config.port, () => {
    logInfo("WhyGuard API listening", {
      port: config.port,
      webhookPath: "/webhooks/github",
      // Never log the token itself — only which mode the read API is running in, so a
      // deployment that forgot to set it is visible in the logs. The public allow-list
      // is logged by name: exposing analyses without a credential should be legible in
      // the first ten lines of a boot log, not discovered later.
      readAccess:
        config.publicRepositories.length > 0
          ? `public for ${config.publicRepositories.join(", ")}`
          : config.apiToken
            ? "token required"
            : "loopback only",
    });
  });
}

main();
