import express, { type Express, type Request, type Response } from "express";
import { WebhookDeliveryDeduplicator, type GitHubAppCredentials } from "@whyguard/github-adapter";
import type { WhyGuardDatabase } from "@whyguard/persistence-adapter";
import type { BedrockInvoker } from "@whyguard/llm-adapter";
import {
  dispatchPullRequestEvent,
  isPullRequestPayload,
  verifyWebhookRequest,
  type WebhookHandlerDeps,
} from "./webhook-handler.js";
import { createReportsRouter } from "./reports-routes.js";
import { logError, logInfo, logWarn } from "./logger.js";
import { apiTokenGuard, rateLimit, securityHeaders } from "./security.js";

/**
 * Minimal HTTP API. Only the routes needed for the GitHub Pull Request
 * review flow are implemented in this phase — the broader `/api/v1/*` surface
 * (analyses, findings, decisions) is deferred to the dashboard phase.
 */

export type CreateServerOptions = {
  credentials: GitHubAppCredentials;
  webhookSecret: string;
  tempRoot?: string;
  /** Largest base repository to clone, in kilobytes. See `ApiConfig.maxRepositorySizeKb`. */
  maxRepositorySizeKb?: number;
  /** Repositories readable without a credential. See `apiTokenGuard`. */
  publicRepositories?: string[];
  /** Injectable for tests; defaults to a fresh in-memory deduplicator. */
  deduplicator?: WebhookDeliveryDeduplicator;
  /** Optional persistence handle (Phase 5). Omit to run without saving scan reports. */
  db?: WhyGuardDatabase;
  /** Optional Bedrock invoker (Phase 5). Omit to always use the deterministic fallback. */
  bedrockInvoker?: BedrockInvoker;
  /**
   * Origins allowed to call the read-only dashboard routes via CORS (e.g. the
   * Vite dev server, `http://localhost:5173`). Defaults to that same origin —
   * the dashboard is a local-only MVP tool, not a public API, so this is
   * intentionally an allow-list rather than `*`. `POST /webhooks/github` is
   * unaffected: GitHub calls it server-to-server, never from a browser.
   */
  dashboardOrigins?: string[];
  /**
   * Shared secret required to read the dashboard routes. When omitted, those routes
   * only answer loopback clients — see `apiTokenGuard`. This is what keeps a public
   * deployment from exposing every repository's analysis history.
   */
  apiToken?: string;
};

const DEFAULT_DASHBOARD_ORIGINS = ["http://localhost:5173"];

/**
 * Read-route budget: generous for a dashboard that fans out a handful of requests per
 * page view, low enough that scripted enumeration of every analysis is not free.
 */
const READ_RATE_LIMIT = { windowMs: 60_000, max: 300 };

/**
 * Webhook budget, kept separate and higher. GitHub can legitimately burst (a push to a
 * busy repository fans out several deliveries) and a rejected *valid* delivery costs a
 * real Check Run, so this limit exists to bound abuse from a forged sender rather than
 * to shape GitHub's traffic. Forged requests are cheap to reject: the signature is
 * checked before any clone happens.
 */
const WEBHOOK_RATE_LIMIT = { windowMs: 60_000, max: 600 };

export function createServer(options: CreateServerOptions): Express {
  const app = express();
  const deduplicator = options.deduplicator ?? new WebhookDeliveryDeduplicator();
  const deps: WebhookHandlerDeps = {
    credentials: options.credentials,
    deduplicator,
    tempRoot: options.tempRoot,
    maxRepositorySizeKb: options.maxRepositorySizeKb,
    db: options.db,
    bedrockInvoker: options.bedrockInvoker,
  };
  const dashboardOrigins = options.dashboardOrigins ?? DEFAULT_DASHBOARD_ORIGINS;

  app.use(securityHeaders());

  // Health checks stay unauthenticated and unlimited: a load balancer or platform
  // probe must be able to reach them, and they expose no data.
  app.get("/health/live", (_req: Request, res: Response) => {
    res.status(200).json({ status: "live" });
  });

  app.get("/health/ready", (_req: Request, res: Response) => {
    res.status(200).json({ status: "ready" });
  });

  // Reported on the integrations screen, so an operator can see which mode is live
  // without reading the process environment. A public allow-list is named first because
  // it is the only mode that serves a caller with no credential at all.
  const resolveReadApiAccess = (
    o: CreateServerOptions,
  ): "token" | "loopback-only" | "public-allow-list" => {
    if ((o.publicRepositories ?? []).length > 0) return "public-allow-list";
    return o.apiToken ? "token" : "loopback-only";
  };

  // Read-only dashboard routes (GET /reports, /reports/:id, /decisions/:id).
  // Only registered when a database is configured — without one, there is
  // nothing to read, so these routes 404 by simply not existing rather than
  // returning a confusing 500 on every request.
  if (options.db) {
    app.use(corsForAllowedOrigins(dashboardOrigins));
    // Order matters: rate-limit before authenticating, so a flood of unauthenticated
    // requests is dropped cheaply instead of running a token comparison each time.
    app.use(rateLimit(READ_RATE_LIMIT));
    app.use(
      apiTokenGuard({
        token: options.apiToken,
        publicRepositories: options.publicRepositories,
      }),
    );
    app.use(
      createReportsRouter(options.db, {
        // Credentials reaching createServer at all means loadConfig validated them.
        githubCredentialsConfigured: Boolean(options.credentials.appId),
        explanationSource: options.bedrockInvoker ? "bedrock" : "fallback",
        readApiAccess: resolveReadApiAccess(options),
        publicRepositories: options.publicRepositories,
      }),
    );
  }

  // Signature verification requires the exact raw request bytes GitHub signed, so
  // this route must receive the unparsed body — do not use express.json() here.
  app.post(
    "/webhooks/github",
    rateLimit(WEBHOOK_RATE_LIMIT),
    express.raw({ type: "application/json", limit: "5mb" }),
    (req: Request, res: Response) => {
      void handleGitHubWebhook(req, res, deps, deduplicator, options.webhookSecret);
    },
  );

  return app;
}

/**
 * Minimal, dependency-free CORS middleware scoped to an explicit origin
 * allow-list, rather than pulling in the `cors` package for three response
 * headers. Only reflects `Origin` back when it's in `allowedOrigins`; every
 * other origin gets no CORS headers at all, so the browser's same-origin
 * policy still blocks it.
 */
function corsForAllowedOrigins(allowedOrigins: string[]) {
  return (req: Request, res: Response, next: () => void) => {
    const origin = req.header("Origin");
    if (origin && allowedOrigins.includes(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
    }
    next();
  };
}

async function handleGitHubWebhook(
  req: Request,
  res: Response,
  deps: WebhookHandlerDeps,
  deduplicator: WebhookDeliveryDeduplicator,
  webhookSecret: string,
): Promise<void> {
  const rawBody = req.body as Buffer;
  const deliveryId = req.header("X-GitHub-Delivery");
  const eventName = req.header("X-GitHub-Event");
  const signatureHeader = req.header("X-Hub-Signature-256");

  // Log every incoming request before any validation, so a misconfigured
  // secret/signature or a request that never reaches GitHub's expected shape is
  // still visible here rather than silently dropped.
  logInfo("Webhook received", {
    deliveryId,
    eventName,
    hasSignatureHeader: signatureHeader !== undefined,
    bodyBytes: rawBody?.length,
  });

  const verification = verifyWebhookRequest({
    rawBody,
    signatureHeader,
    deliveryId,
    eventName,
    secret: webhookSecret,
  });
  if (!verification.ok) {
    logWarn("Webhook rejected", {
      deliveryId,
      eventName,
      status: verification.status,
      reason: verification.reason,
    });
    res.status(verification.status).json({ error: verification.reason });
    return;
  }

  // deliveryId is guaranteed defined past verifyWebhookRequest's "ok: true" branch.
  if (deduplicator.isDuplicate(deliveryId as string)) {
    logInfo("Webhook ignored: duplicate delivery", { deliveryId, eventName });
    res.status(200).json({ status: "duplicate_ignored" });
    return;
  }
  deduplicator.markProcessed(deliveryId as string);

  if (eventName !== "pull_request") {
    logInfo("Webhook acknowledged but ignored: unsupported event type", {
      deliveryId,
      eventName,
    });
    res.status(202).json({ status: `ignored_event_${eventName}` });
    return;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody.toString("utf-8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logError("Webhook rejected: malformed JSON payload", { deliveryId, eventName, message });
    res.status(400).json({ error: "Malformed JSON payload." });
    return;
  }

  if (!isPullRequestPayload(payload)) {
    logError("Webhook rejected: payload does not look like a pull_request event", {
      deliveryId,
      eventName,
    });
    res.status(400).json({ error: "Payload does not look like a pull_request event." });
    return;
  }

  logInfo("Dispatching pull_request event", {
    deliveryId,
    action: payload.action,
    owner: payload.repository.owner.login,
    repo: payload.repository.name,
    pullNumber: payload.number,
  });

  // Acknowledge immediately; the scan can take longer than a webhook delivery's
  // timeout budget. A future phase should move this to a queue/worker
  // — for this phase, respond first and let the scan run to completion afterward,
  // publishing the Check Run whenever it finishes.
  res.status(202).json({ status: "accepted" });

  const result = await dispatchPullRequestEvent(deps, payload);
  if (!result.handled) {
    // Deliberately not re-thrown: the HTTP response was already sent. Surface the
    // failure through logs only — `reason` never includes credentials
    // (scanPullRequest/git-adapter redact those already).
    logError("Dispatch did not complete successfully", { deliveryId, reason: result.reason });
  } else {
    logInfo("Dispatch completed", { deliveryId, checkRunUrl: result.checkRunUrl ?? undefined });
    if (result.persistError) {
      // The Check Run already published successfully; a persistence failure is a
      // separate, non-fatal problem worth knowing about but must not be reported
      // as if the scan itself failed.
      logError("Failed to persist scan report", { deliveryId, reason: result.persistError });
    }
  }
}
