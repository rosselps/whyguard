import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  dispatchPullRequestEvent,
  isPullRequestPayload,
  verifyWebhookRequest,
  type PullRequestWebhookPayload,
} from "./webhook-handler.js";

/**
 * Contract tests for the webhook handler logic, using simulated `pull_request`
 * payload shapes rather than live GitHub webhook deliveries or a real GitHub App.
 * Per.
 */

function sign(payload: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(payload).digest("hex")}`;
}

describe("verifyWebhookRequest", () => {
  const secret = "test-secret";
  const rawBody = JSON.stringify({ action: "opened" });

  it("accepts a request with valid signature and required headers", () => {
    const result = verifyWebhookRequest({
      rawBody,
      signatureHeader: sign(rawBody, secret),
      deliveryId: "delivery-1",
      eventName: "pull_request",
      secret,
    });
    expect(result).toEqual({ ok: true });
  });

  it("rejects a request missing the delivery id", () => {
    const result = verifyWebhookRequest({
      rawBody,
      signatureHeader: sign(rawBody, secret),
      deliveryId: undefined,
      eventName: "pull_request",
      secret,
    });
    expect(result).toEqual({ ok: false, status: 400, reason: "Missing X-GitHub-Delivery header." });
  });

  it("rejects a request missing the event name", () => {
    const result = verifyWebhookRequest({
      rawBody,
      signatureHeader: sign(rawBody, secret),
      deliveryId: "delivery-1",
      eventName: undefined,
      secret,
    });
    expect(result).toEqual({ ok: false, status: 400, reason: "Missing X-GitHub-Event header." });
  });

  it("rejects a request with an invalid signature", () => {
    const result = verifyWebhookRequest({
      rawBody,
      signatureHeader: sign(rawBody, "wrong-secret"),
      deliveryId: "delivery-1",
      eventName: "pull_request",
      secret,
    });
    expect(result).toEqual({ ok: false, status: 401, reason: "Invalid webhook signature." });
  });
});

describe("isPullRequestPayload", () => {
  const validPayload: PullRequestWebhookPayload = {
    action: "opened",
    number: 493,
    installation: { id: 12345 },
    repository: { name: "whyguard-demo", owner: { login: "demo-org" } },
  };

  it("accepts a well-formed pull_request payload", () => {
    expect(isPullRequestPayload(validPayload)).toBe(true);
  });

  it("rejects null", () => {
    expect(isPullRequestPayload(null)).toBe(false);
  });

  it("rejects a payload missing 'action'", () => {
    const { action, ...rest } = validPayload;
    void action;
    expect(isPullRequestPayload(rest)).toBe(false);
  });

  it("rejects a payload missing 'repository'", () => {
    const { repository, ...rest } = validPayload;
    void repository;
    expect(isPullRequestPayload(rest)).toBe(false);
  });

  it("rejects a payload where 'number' is not a number", () => {
    expect(isPullRequestPayload({ ...validPayload, number: "493" })).toBe(false);
  });
});

describe("dispatchPullRequestEvent", () => {
  const basePayload: PullRequestWebhookPayload = {
    action: "opened",
    number: 493,
    installation: { id: 12345 },
    repository: { name: "whyguard-demo", owner: { login: "demo-org" } },
  };
  const deps = {
    credentials: { appId: "1", privateKey: "test" },
    deduplicator: new (class {
      isDuplicate(): boolean {
        return false;
      }
      markProcessed(): void {}
    })() as never,
  };

  it("ignores an action it does not handle (e.g. 'closed')", async () => {
    const result = await dispatchPullRequestEvent(deps, { ...basePayload, action: "closed" });
    expect(result).toEqual({
      handled: false,
      reason: 'Ignoring pull_request action "closed".',
    });
  });

  it("reports a missing installation id without crashing", async () => {
    const result = await dispatchPullRequestEvent(deps, {
      ...basePayload,
      installation: undefined,
    });
    expect(result).toEqual({ handled: false, reason: "Webhook payload has no installation id." });
  });

  it("reports scanPullRequest failures as handled:false instead of throwing", async () => {
    // No real GitHub App/network is reachable with these fake credentials, so
    // scanPullRequest is guaranteed to fail deep inside github-adapter/git-adapter.
    // This asserts the failure is caught and reported, never thrown or crashed on.
    const result = await dispatchPullRequestEvent(deps, basePayload);
    expect(result.handled).toBe(false);
    if (!result.handled) {
      expect(result.reason).toContain("scanPullRequest failed");
    }
  });
});
