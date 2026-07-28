import { decodePrivateKeyBase64, type GitHubAppCredentials } from "@whyguard/github-adapter";

/**
 * Environment configuration for apps/api.
 * Reads process.env exactly once, at startup, and fails fast with a clear message
 * if required GitHub App credentials are missing — rather than letting a webhook
 * request fail confusingly later.
 */

export class MissingConfigError extends Error {
  constructor(missingKeys: string[]) {
    super(
      `Missing required environment variable(s): ${missingKeys.join(", ")}. ` +
        `Copy .env.example to .env in the repository root and fill in your GitHub App ` +
        `credentials (App ID, base64-encoded private key, webhook secret) — see ` +
        `docs/deploy/github-app.md.`,
    );
    this.name = "MissingConfigError";
  }
}

export type BedrockConfig = {
  region: string;
  modelId: string;
};

export type ApiConfig = {
  port: number;
  githubWebhookSecret: string;
  githubCredentials: GitHubAppCredentials;
  tempRoot: string | undefined;
  /** DATABASE_URL, e.g. "file:./data/whyguard.db". Defaults to that same value. */
  databaseUrl: string;
  /**
   * Bedrock is attempted only when explicitly enabled AND fully configured.
   * `undefined` means "always use the deterministic fallback" — the safe default, and
   * what every test and the CLI rely on.
   *
   * `WHYGUARD_LLM_ENABLED=true` without `AWS_REGION`/`BEDROCK_MODEL_ID` is treated the
   * same as disabled rather than throwing at startup: an incomplete Bedrock setup must
   * still leave a working tool, since explanations are decoration on a deterministic
   * verdict.
   */
  bedrock: BedrockConfig | undefined;
  /**
   * Shared secret required to read the dashboard routes. Optional on purpose: unset
   * means "loopback only", which keeps local development frictionless while making a
   * public deployment fail closed rather than expose every analysis. See
   * `apiTokenGuard`.
   */
  apiToken: string | undefined;
  /**
   * Largest base repository WhyGuard will clone for a webhook scan, in kilobytes.
   * `undefined` means "use the application default"; `0` disables the guard.
   *
   * Configured in megabytes (`WHYGUARD_MAX_REPO_SIZE_MB`) because that is the unit an
   * operator sizing a disk actually thinks in, and converted here so the application
   * layer keeps GitHub's own unit.
   */
  maxRepositorySizeKb: number | undefined;
  /**
   * Repositories, as `owner/repo`, whose analyses are readable with no credential.
   * Empty keeps the API closed to remote callers. See `apiTokenGuard`.
   */
  publicRepositories: string[];
  /**
   * Browser origins allowed to call the read routes. Empty keeps the local default
   * (`http://localhost:5173`); a deployed dashboard has to be named here or every
   * request from it fails CORS.
   */
  dashboardOrigins: string[];
};

/** Loads and validates configuration from environment variables. Throws MissingConfigError if incomplete. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const required: Record<string, string | undefined> = {
    GITHUB_APP_ID: env.GITHUB_APP_ID?.trim(),
    GITHUB_PRIVATE_KEY_BASE64: env.GITHUB_PRIVATE_KEY_BASE64?.trim(),
    GITHUB_WEBHOOK_SECRET: env.GITHUB_WEBHOOK_SECRET?.trim(),
  };
  const missing = Object.entries(required)
    .filter(([, value]) => !value)
    .map(([key]) => key);
  if (missing.length > 0) {
    throw new MissingConfigError(missing);
  }

  const appId = required.GITHUB_APP_ID;
  const privateKeyBase64 = required.GITHUB_PRIVATE_KEY_BASE64;
  const webhookSecret = required.GITHUB_WEBHOOK_SECRET;
  if (!appId || !privateKeyBase64 || !webhookSecret) {
    // Unreachable given the check above; narrows types for TypeScript.
    throw new MissingConfigError(missing);
  }

  return {
    port: Number(env.PORT ?? 3000),
    githubWebhookSecret: webhookSecret,
    githubCredentials: {
      appId,
      privateKey: decodePrivateKeyBase64(privateKeyBase64),
    },
    tempRoot: env.WHYGUARD_TEMP_ROOT,
    databaseUrl: env.DATABASE_URL?.trim() || "file:./data/whyguard.db",
    bedrock: loadBedrockConfig(env),
    apiToken: env.WHYGUARD_API_TOKEN?.trim() || undefined,
    maxRepositorySizeKb: loadMaxRepositorySizeKb(env),
    publicRepositories: loadPublicRepositories(env),
    dashboardOrigins: loadList(env.WHYGUARD_DASHBOARD_ORIGINS),
  };
}

/** Splits a comma-separated environment value, dropping blanks. */
function loadList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/**
 * Reads `WHYGUARD_PUBLIC_REPOS`: a comma-separated list of `owner/repo`.
 *
 * Entries without a slash are dropped rather than accepted, because a bare `whyguard`
 * would never match a stored `owner/repo` name and would look like a working
 * configuration that silently exposes nothing — or, if matching were loosened later,
 * like one that exposes too much.
 */
function loadPublicRepositories(env: NodeJS.ProcessEnv): string[] {
  return loadList(env.WHYGUARD_PUBLIC_REPOS).filter((entry) => entry.includes("/"));
}

/**
 * Reads `WHYGUARD_MAX_REPO_SIZE_MB`. An unparseable or negative value is treated as
 * unset rather than as `0`: silently disabling a disk-protection guard because someone
 * typed `2gb` is the opposite of what the operator intended.
 */
function loadMaxRepositorySizeKb(env: NodeJS.ProcessEnv): number | undefined {
  const raw = env.WHYGUARD_MAX_REPO_SIZE_MB?.trim();
  if (!raw) return undefined;
  const megabytes = Number(raw);
  if (!Number.isFinite(megabytes) || megabytes < 0) return undefined;
  return Math.round(megabytes * 1024);
}

function loadBedrockConfig(env: NodeJS.ProcessEnv): BedrockConfig | undefined {
  if (env.WHYGUARD_LLM_ENABLED?.trim() !== "true") return undefined;
  const region = env.AWS_REGION?.trim();
  const modelId = env.BEDROCK_MODEL_ID?.trim();
  if (!region || !modelId) return undefined;
  return { region, modelId };
}
