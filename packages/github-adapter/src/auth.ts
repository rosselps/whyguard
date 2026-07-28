import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";

/**
 * GitHub App authentication.
 *
 * WhyGuard authenticates as a GitHub App (JWT), then exchanges that for a
 * short-lived installation access token scoped to a single installation. No
 * personal access tokens, no OAuth user tokens — only the minimum permissions the
 * App was granted (Contents: Read, Pull requests: Read, Issues: Read, Checks: Write,
 * Metadata: Read).
 *
 * Credentials (`GITHUB_APP_ID`, `GITHUB_PRIVATE_KEY_BASE64`, `GITHUB_WEBHOOK_SECRET`)
 * are read from environment variables by the caller and passed in explicitly — this
 * module never reads `process.env` directly, so it stays testable and so no secret
 * is ever logged from here.
 */

export type GitHubAppCredentials = {
  appId: string;
  /** PEM private key, already decoded from base64 (see decodePrivateKey below). */
  privateKey: string;
};

export class InvalidGitHubCredentialsError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "InvalidGitHubCredentialsError";
  }
}

/** Decodes the base64-encoded PEM private key from `GITHUB_PRIVATE_KEY_BASE64`. */
export function decodePrivateKeyBase64(base64Key: string): string {
  if (!base64Key.trim()) {
    throw new InvalidGitHubCredentialsError("GITHUB_PRIVATE_KEY_BASE64 is empty.");
  }
  let decoded: string;
  try {
    decoded = Buffer.from(base64Key, "base64").toString("utf-8");
  } catch (error) {
    throw new InvalidGitHubCredentialsError("GITHUB_PRIVATE_KEY_BASE64 is not valid base64.", {
      cause: error,
    });
  }
  if (!decoded.includes("PRIVATE KEY")) {
    throw new InvalidGitHubCredentialsError(
      "Decoded GITHUB_PRIVATE_KEY_BASE64 does not look like a PEM private key.",
    );
  }
  return decoded;
}

/**
 * Creates an Octokit client authenticated as the GitHub App itself (JWT auth).
 * Used only for App-level endpoints (e.g. listing installations) — most work should
 * use `createInstallationClient` instead, which is scoped to one installation.
 */
export function createAppClient(credentials: GitHubAppCredentials): Octokit {
  return new Octokit({
    authStrategy: createAppAuth,
    auth: { appId: credentials.appId, privateKey: credentials.privateKey },
  });
}

/**
 * Creates an Octokit client authenticated as a specific installation. This is what
 * every repository-scoped operation (reading a PR, posting a Check Run) should use.
 */
export function createInstallationClient(
  credentials: GitHubAppCredentials,
  installationId: number,
): Octokit {
  return new Octokit({
    authStrategy: createAppAuth,
    auth: {
      appId: credentials.appId,
      privateKey: credentials.privateKey,
      installationId,
    },
  });
}

/**
 * Fetches a raw, short-lived installation access token string. Needed only for
 * operations that cannot go through Octokit directly — namely building a Git clone
 * URL (`https://x-access-token:<token>@github.com/<owner>/<repo>.git`) for
 * `git-adapter`'s `cloneRepository`. Every other GitHub operation should use
 * `createInstallationClient` instead of handling this token manually.
 */
export async function getInstallationAccessToken(
  credentials: GitHubAppCredentials,
  installationId: number,
): Promise<string> {
  const auth = createAppAuth({
    appId: credentials.appId,
    privateKey: credentials.privateKey,
  });
  const installationAuth = await auth({ type: "installation", installationId });
  return installationAuth.token;
}

/** Builds an authenticated HTTPS clone URL embedding a short-lived installation token. */
export function buildInstallationCloneUrl(
  owner: string,
  repo: string,
  installationToken: string,
): string {
  return `https://x-access-token:${installationToken}@github.com/${owner}/${repo}.git`;
}
