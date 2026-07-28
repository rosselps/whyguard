import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyWebhookSignature, WebhookDeliveryDeduplicator } from "./webhook-signature.js";

function signPayload(payload: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(payload).digest("hex")}`;
}

describe("verifyWebhookSignature", () => {
  const secret = "test-webhook-secret";
  const payload = JSON.stringify({ action: "opened", number: 493 });

  it("accepts a correctly signed payload", () => {
    const signature = signPayload(payload, secret);
    expect(verifyWebhookSignature(payload, signature, secret)).toBe(true);
  });

  it("rejects a payload signed with the wrong secret", () => {
    const signature = signPayload(payload, "wrong-secret");
    expect(verifyWebhookSignature(payload, signature, secret)).toBe(false);
  });

  it("rejects a tampered payload with a signature for the original payload", () => {
    const signature = signPayload(payload, secret);
    const tamperedPayload = JSON.stringify({ action: "opened", number: 999 });
    expect(verifyWebhookSignature(tamperedPayload, signature, secret)).toBe(false);
  });

  it("rejects a missing signature header", () => {
    expect(verifyWebhookSignature(payload, undefined, secret)).toBe(false);
  });

  it("rejects a signature header without the sha256= prefix", () => {
    const badHeader = createHmac("sha256", secret).update(payload).digest("hex");
    expect(verifyWebhookSignature(payload, badHeader, secret)).toBe(false);
  });

  it("rejects when the configured secret is empty", () => {
    const signature = signPayload(payload, secret);
    expect(verifyWebhookSignature(payload, signature, "")).toBe(false);
  });

  it("rejects a signature of a different length without throwing", () => {
    expect(verifyWebhookSignature(payload, "sha256=short", secret)).toBe(false);
  });

  it("works against a Buffer payload the same way as a string payload", () => {
    const buffer = Buffer.from(payload, "utf-8");
    const signature = signPayload(payload, secret);
    expect(verifyWebhookSignature(buffer, signature, secret)).toBe(true);
  });
});

describe("WebhookDeliveryDeduplicator", () => {
  it("treats an unseen delivery ID as not a duplicate", () => {
    const dedup = new WebhookDeliveryDeduplicator();
    expect(dedup.isDuplicate("delivery-1")).toBe(false);
  });

  it("treats a marked delivery ID as a duplicate on subsequent checks", () => {
    const dedup = new WebhookDeliveryDeduplicator();
    dedup.markProcessed("delivery-1");
    expect(dedup.isDuplicate("delivery-1")).toBe(true);
  });

  it("evicts the oldest entry once over capacity", () => {
    const dedup = new WebhookDeliveryDeduplicator(2);
    dedup.markProcessed("delivery-1");
    dedup.markProcessed("delivery-2");
    dedup.markProcessed("delivery-3"); // should evict delivery-1
    expect(dedup.isDuplicate("delivery-1")).toBe(false);
    expect(dedup.isDuplicate("delivery-2")).toBe(true);
    expect(dedup.isDuplicate("delivery-3")).toBe(true);
  });
});
