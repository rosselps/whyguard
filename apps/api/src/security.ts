import { timingSafeEqual } from "node:crypto";
import type { Request, Response } from "express";

/**
 * Access control and abuse limits for the HTTP API.
 *
 * Why this exists: the read routes (`/reports`, `/reports/:id`, `/decisions/:id`,
 * `/findings/:id/regression-test`) return analysis history for every repository the
 * GitHub App is installed on — file paths, changed code fragments, protected
 * properties, evidence and issue references. That is acceptable while the API only
 * listens on a developer's machine. The moment it is deployed to a public URL, an
 * unauthenticated reader can enumerate every analysis of every repository, including
 * private ones. Nothing in the routes themselves prevents that, so it is enforced
 * here, ahead of them.
 */

/** Loopback forms Node reports for a local client, including IPv4-mapped IPv6. */
const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

function isLoopback(req: Request): boolean {
  const address = req.socket.remoteAddress ?? "";
  return LOOPBACK_ADDRESSES.has(address);
}

function constantTimeEquals(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, "utf-8");
  const bufferB = Buffer.from(b, "utf-8");
  // timingSafeEqual throws on length mismatch, which would itself leak length.
  // Compare fixed-size digests of equal length instead by padding to the longer one.
  if (bufferA.length !== bufferB.length) return false;
  return timingSafeEqual(bufferA, bufferB);
}

export type ApiTokenGuardOptions = {
  /**
   * Shared secret required in `Authorization: Bearer <token>`. When omitted, the
   * guard falls back to allowing loopback clients only — safe by default for local
   * development, and a hard stop for a deployment that forgot to configure a token.
   */
  token?: string;
  /**
   * Repositories, as `owner/repo`, whose analyses may be read with no credential.
   * A non-empty list is what enables public read at all.
   *
   * An allow-list rather than a boolean on purpose. A `PUBLIC_READ=true` flag would
   * expose every repository the App is ever installed on, including private ones
   * added months later by someone who never saw the flag. Naming what is public keeps
   * the blast radius equal to what somebody deliberately typed.
   */
  publicRepositories?: string[];
};

/** How the current request was authorized. Routes read this to decide what to serve. */
export type AccessMode = "token" | "loopback" | "public";

/** Where the guard records the mode for downstream routes. */
export function accessModeOf(res: Response): AccessMode {
  return (res.locals as { whyguardAccess?: AccessMode }).whyguardAccess ?? "public";
}

/**
 * Guards the read API, in order of decreasing trust:
 *
 * - **Valid bearer token** — full access. Compared in constant time so a wrong token
 *   cannot be discovered byte-by-byte through response timing.
 * - **Loopback** — full access, so local development needs no configuration.
 * - **Public allow-list configured** — access continues, but as `"public"`, and the
 *   routes then serve only the named repositories.
 * - **Otherwise** — 401. A deployment that configured neither fails closed rather
 *   than silently exposing every analysis.
 */
export function apiTokenGuard(options: ApiTokenGuardOptions) {
  const { token } = options;
  const hasPublicRepositories = (options.publicRepositories ?? []).length > 0;

  return (req: Request, res: Response, next: () => void): void => {
    const grant = (mode: AccessMode): void => {
      (res.locals as { whyguardAccess?: AccessMode }).whyguardAccess = mode;
      next();
    };

    const header = req.header("Authorization") ?? "";
    const presented = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";

    if (token) {
      if (presented) {
        if (constantTimeEquals(presented, token)) {
          grant("token");
          return;
        }
        // A wrong token is always an error, never a silent downgrade to public data:
        // a typo in a deployment's token must look broken rather than look like it
        // worked while quietly serving a different, smaller dataset.
        res.status(401).json({ error: "Missing or invalid API token." });
        return;
      }
      // Loopback deliberately does NOT bypass a configured token. Once an operator has
      // set one, "runs on this machine" stops being sufficient proof of anything —
      // otherwise anything else on the host reaches the full history for free.
    } else if (isLoopback(req)) {
      grant("loopback");
      return;
    }

    if (hasPublicRepositories) {
      grant("public");
      return;
    }

    res.status(401).json({
      error:
        "This WhyGuard API is not configured for remote access. Set WHYGUARD_API_TOKEN " +
        "and send it as 'Authorization: Bearer <token>', or set WHYGUARD_PUBLIC_REPOS " +
        "to expose named repositories without a credential.",
    });
  };
}

export type RateLimitOptions = {
  windowMs: number;
  /** Maximum requests allowed per client within one window. */
  max: number;
};

type WindowState = { count: number; resetAt: number };

/**
 * Fixed-window, in-memory rate limiter keyed by client address.
 *
 * Intentionally dependency-free and per-process: it protects a single instance from
 * trivial abuse (enumeration loops, accidental request storms) without pretending to
 * be a distributed limiter. Behind multiple instances or a CDN, the real limit belongs
 * at the edge — this is a floor, not a ceiling, and that trade-off is why the window
 * state is not shared anywhere.
 *
 * Expired entries are pruned lazily on access, so an idle process does not hold state
 * for clients that stopped calling.
 */
export function rateLimit(options: RateLimitOptions) {
  const windows = new Map<string, WindowState>();

  return (req: Request, res: Response, next: () => void): void => {
    const key = req.socket.remoteAddress ?? "unknown";
    const now = Date.now();
    const existing = windows.get(key);

    if (!existing || existing.resetAt <= now) {
      windows.set(key, { count: 1, resetAt: now + options.windowMs });
      // Opportunistic prune: bounded work per request, keeps the map from growing
      // without limit across many distinct clients.
      if (windows.size > 10_000) {
        for (const [entryKey, state] of windows) {
          if (state.resetAt <= now) windows.delete(entryKey);
        }
      }
      next();
      return;
    }

    existing.count += 1;
    if (existing.count > options.max) {
      const retryAfterSeconds = Math.max(1, Math.ceil((existing.resetAt - now) / 1000));
      res.setHeader("Retry-After", String(retryAfterSeconds));
      res.status(429).json({ error: "Too many requests." });
      return;
    }

    next();
  };
}

/**
 * Baseline response headers for a JSON API.
 *
 * `nosniff` stops a browser from reinterpreting a JSON error body as HTML (the vector
 * for turning an echoed error message into stored XSS), and denying framing plus
 * trimming the referrer costs nothing on an API that is never meant to be embedded.
 */
export function securityHeaders() {
  return (_req: Request, res: Response, next: () => void): void => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    next();
  };
}
