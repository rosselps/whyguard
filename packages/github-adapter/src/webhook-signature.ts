import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * GitHub webhook signature validation: "Verify `X-Hub-Signature-256` using constant-time comparison."
 *
 * Implemented directly with Node's `crypto` module (HMAC-SHA256 + timingSafeEqual)
 * rather than delegating to `@octokit/webhooks-methods`, so this stays a small, fully
 * auditable, dependency-free trust boundary — the single place that decides whether
 * an inbound HTTP request is trusted as "really from GitHub".
 */

const SIGNATURE_PREFIX = "sha256=";

/**
 * Verifies a GitHub webhook payload against its `X-Hub-Signature-256` header value.
 *
 * @param payload The raw request body as received (before any JSON parsing —
 *   signature verification must run against the exact bytes GitHub signed).
 * @param signatureHeader The full header value, e.g. `"sha256=abcdef..."`.
 * @param secret The webhook secret configured on the GitHub App.
 */
export function verifyWebhookSignature(
  payload: string | Buffer,
  signatureHeader: string | undefined,
  secret: string,
): boolean {
  if (!signatureHeader || !signatureHeader.startsWith(SIGNATURE_PREFIX)) {
    return false;
  }
  if (!secret) {
    return false;
  }

  const expectedHex = createHmac("sha256", secret).update(payload).digest("hex");
  const expected = Buffer.from(SIGNATURE_PREFIX + expectedHex, "utf-8");
  const received = Buffer.from(signatureHeader, "utf-8");

  // timingSafeEqual throws if buffer lengths differ; a length mismatch means the
  // signatures cannot possibly match, so treat it as a verification failure rather
  // than letting the exception escape.
  if (expected.length !== received.length) {
    return false;
  }
  return timingSafeEqual(expected, received);
}

/**
 * In-memory delivery-ID deduplication webhook-replay threat. This is a
 * simple bounded cache — sufficient for a single-process MVP deployment. A
 * multi-instance deployment would need a shared store (e.g. the persistence-adapter
 * planned for a later phase) instead.
 */
export class WebhookDeliveryDeduplicator {
  private readonly seen = new Map<string, number>();

  constructor(private readonly maxEntries = 10_000) {}

  /** Returns true if this delivery ID was already seen (and should be rejected). */
  isDuplicate(deliveryId: string): boolean {
    return this.seen.has(deliveryId);
  }

  /** Records a delivery ID as processed. Evicts the oldest entry if over capacity. */
  markProcessed(deliveryId: string): void {
    if (this.seen.size >= this.maxEntries) {
      const oldestKey = this.seen.keys().next().value;
      if (oldestKey !== undefined) this.seen.delete(oldestKey);
    }
    this.seen.set(deliveryId, Date.now());
  }
}
