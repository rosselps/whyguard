import {
  buildInstallationCloneUrl,
  createInstallationClient,
  getInstallationAccessToken,
  verifyWebhookSignature,
  type GitHubAppCredentials,
  type WebhookDeliveryDeduplicator,
} from "@whyguard/github-adapter";
import { scanPullRequest } from "@whyguard/application";
import {
  saveScanReport,
  updateFindingLlmExplanation,
  upsertDecision,
  type WhyGuardDatabase,
} from "@whyguard/persistence-adapter";
import { explainFinding, type BedrockInvoker } from "@whyguard/llm-adapter";

/**
 * `POST /webhooks/github` handler logic.
 *
 * Handles `pull_request` events with actions `opened`, `synchronize`, `reopened`. Every other event is acknowledged but ignored — GitHub still
 * expects a 2xx response for event types the App is subscribed to but does not
 * act on, otherwise it will retry and eventually flag the webhook as failing.
 */

const HANDLED_PULL_REQUEST_ACTIONS = new Set(["opened", "synchronize", "reopened"]);

export type WebhookHandlerDeps = {
  credentials: GitHubAppCredentials;
  deduplicator: WebhookDeliveryDeduplicator;
  tempRoot?: string;
  /** Largest base repository to clone, in kilobytes. See `ApiConfig.maxRepositorySizeKb`. */
  maxRepositorySizeKb?: number;
  /**
   * Optional persistence handle (Phase 5). When omitted, dispatch behaves exactly
   * as before persistence existed — the Check Run is still published, nothing is
   * saved. When present, a successful scan's report is saved so the dashboard can
   * list/inspect it later.
   */
  db?: WhyGuardDatabase;
  /**
   * Optional Bedrock invoker (Phase 5). Omit to always use the deterministic
   * fallback explanation — see `@whyguard/llm-adapter`'s `explainFinding` for
   * the full fallback contract. Only meaningful when `db` is also provided,
   * since there is nowhere to persist an explanation otherwise.
   */
  bedrockInvoker?: BedrockInvoker;
};

export type WebhookVerificationInput = {
  rawBody: Buffer | string;
  signatureHeader: string | undefined;
  deliveryId: string | undefined;
  eventName: string | undefined;
  secret: string;
};

export type WebhookVerificationResult =
  { ok: true } | { ok: false; status: number; reason: string };

/**
 * Pure verification step (signature + presence of a delivery ID), separated from
 * dispatch so it can be unit-tested without any GitHub API calls or Octokit client.
 */
export function verifyWebhookRequest(input: WebhookVerificationInput): WebhookVerificationResult {
  if (!input.deliveryId) {
    return { ok: false, status: 400, reason: "Missing X-GitHub-Delivery header." };
  }
  if (!input.eventName) {
    return { ok: false, status: 400, reason: "Missing X-GitHub-Event header." };
  }
  if (!verifyWebhookSignature(input.rawBody, input.signatureHeader, input.secret)) {
    return { ok: false, status: 401, reason: "Invalid webhook signature." };
  }
  return { ok: true };
}

/**
 * Narrow shape of the fields WhyGuard actually needs from a `pull_request` webhook
 * payload. Deliberately not the full GitHub payload type — only what is read.
 */
export type PullRequestWebhookPayload = {
  action: string;
  number: number;
  installation?: { id: number };
  repository: { name: string; owner: { login: string } };
};

export function isPullRequestPayload(payload: unknown): payload is PullRequestWebhookPayload {
  if (typeof payload !== "object" || payload === null) return false;
  const candidate = payload as Record<string, unknown>;
  return (
    typeof candidate.action === "string" &&
    typeof candidate.number === "number" &&
    typeof candidate.repository === "object" &&
    candidate.repository !== null
  );
}

export type DispatchResult =
  | { handled: true; checkRunUrl: string | null; persistError?: string }
  | { handled: false; reason: string };

/**
 * Dispatches an already-verified, already-deduplicated `pull_request` webhook event
 * to `scanPullRequest`. Any error from the scan (e.g. a clone failure) is caught and
 * reported as `handled: false` with a reason, rather than thrown — hook
 * philosophy applies here too: a tooling failure must not be reported as an unsafe
 * finding, and must not crash the process handling other webhooks.
 */
export async function dispatchPullRequestEvent(
  deps: WebhookHandlerDeps,
  payload: PullRequestWebhookPayload,
): Promise<DispatchResult> {
  if (!HANDLED_PULL_REQUEST_ACTIONS.has(payload.action)) {
    return { handled: false, reason: `Ignoring pull_request action "${payload.action}".` };
  }
  const installationId = payload.installation?.id;
  if (!installationId) {
    return { handled: false, reason: "Webhook payload has no installation id." };
  }

  const owner = payload.repository.owner.login;
  const repo = payload.repository.name;

  try {
    const client = createInstallationClient(deps.credentials, installationId);
    const token = await getInstallationAccessToken(deps.credentials, installationId);
    const cloneUrl = buildInstallationCloneUrl(owner, repo, token);

    const { report, checkRun, decisions } = await scanPullRequest({
      client,
      owner,
      repo,
      pullNumber: payload.number,
      cloneUrl,
      tempRoot: deps.tempRoot,
      maxRepositorySizeKb: deps.maxRepositorySizeKb,
    });

    // Persistence is best-effort and never turns a successful scan+Check-Run into
    // a reported failure: the GitHub-facing result (the Check Run) already
    // happened and is the thing PR authors/reviewers depend on. A persistence
    // failure is surfaced via `persistError` so the caller can log it, not by
    // failing the whole dispatch.
    let persistError: string | undefined;
    if (deps.db) {
      try {
        // Cache every active rationale contract this scan saw, so a finding's
        // matchingDecisionId resolves to a real row in GET /decisions/:id
        // instead of always 404ing.
        for (const contract of decisions) {
          upsertDecision(deps.db, { contract });
        }
        saveScanReport(deps.db, report, {
          pullRequestNumber: payload.number,
          checkRunUrl: checkRun.htmlUrl ?? undefined,
        });

        // compute an explanation for
        // every finding, deterministic-fallback-first. `explainFinding` never
        // throws for a Bedrock-side failure, so a slow/broken model call here
        // only ever costs latency, never correctness — and rule
        // 6, the deterministic path always exists regardless of `bedrockInvoker`.
        for (const finding of report.findings) {
          const explanation = await explainFinding(finding, { invoker: deps.bedrockInvoker });
          updateFindingLlmExplanation(deps.db, finding.id, explanation);
        }
      } catch (error) {
        persistError = error instanceof Error ? error.message : String(error);
      }
    }

    return { handled: true, checkRunUrl: checkRun.htmlUrl, persistError };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { handled: false, reason: `scanPullRequest failed: ${message}` };
  }
}
