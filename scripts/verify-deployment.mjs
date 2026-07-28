#!/usr/bin/env node
import { createHmac, randomUUID } from "node:crypto";

/**
 * Checks a deployed WhyGuard API from the outside: HTTPS, health, webhook signature
 * verification, read-access mode, and that the API port is not directly reachable.
 *
 * The signature check is the point of this script. Everything about the webhook path
 * that a reverse proxy can quietly break — raw body bytes, header casing, request size
 * limits — only breaks once the API is behind one, and "the service is up" does not
 * detect it. So it signs a real payload with the real secret and expects the API to
 * accept it, then flips one byte and expects a 401.
 *
 * Usage:
 *   node scripts/verify-deployment.mjs --url https://api.example.com
 *   node scripts/verify-deployment.mjs --url https://api.example.com --secret <webhook secret>
 *   node scripts/verify-deployment.mjs --url https://d1.cloudfront.net --origin <ec2 public dns>
 *   node scripts/verify-deployment.mjs --url http://localhost:3000 --secret dev --allow-open-port
 *
 * Without --secret the signature checks are skipped, not faked.
 */

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index !== -1 && args[index + 1] ? args[index + 1] : fallback;
};

const baseUrl = (value("url", "") || "").replace(/\/+$/, "");
if (!baseUrl) {
  process.stderr.write(
    "\n  usage: node scripts/verify-deployment.mjs --url <base url> [--secret <s>]\n\n",
  );
  process.exit(1);
}
const secret = value("secret", process.env.GITHUB_WEBHOOK_SECRET ?? "");

const green = (t) => `\u001B[32m${t}\u001B[39m`;
const red = (t) => `\u001B[31m${t}\u001B[39m`;
const dim = (t) => `\u001B[2m${t}\u001B[22m`;
const yellow = (t) => `\u001B[33m${t}\u001B[39m`;

let failures = 0;
let skipped = 0;

function pass(label, detail) {
  process.stdout.write(`  ${green("✓")} ${label}${detail ? dim(`  ${detail}`) : ""}\n`);
}
function fail(label, detail) {
  failures += 1;
  process.stdout.write(`  ${red("✖")} ${label}${detail ? `  ${red(detail)}` : ""}\n`);
}
function skip(label, reason) {
  skipped += 1;
  process.stdout.write(`  ${yellow("−")} ${label}${reason ? dim(`  ${reason}`) : ""}\n`);
}
function section(text) {
  process.stdout.write(`\n  ${text}\n`);
}

async function request(path, init = {}, timeoutMs = 15_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${baseUrl}${path}`, { ...init, signal: controller.signal });
    const text = await response.text();
    return { status: response.status, text };
  } finally {
    clearTimeout(timer);
  }
}

/** Mirrors what GitHub sends: sha256 HMAC of the exact bytes of the body. */
function signedHeaders(body, withSecret) {
  const digest = createHmac("sha256", withSecret).update(body).digest("hex");
  return {
    "Content-Type": "application/json",
    "X-GitHub-Event": "ping",
    "X-GitHub-Delivery": randomUUID(),
    "X-Hub-Signature-256": `sha256=${digest}`,
  };
}

async function checkHealth() {
  section("Reachability");
  for (const path of ["/health/live", "/health/ready"]) {
    try {
      const { status, text } = await request(path);
      if (status === 200) pass(`GET ${path}`, text.slice(0, 60));
      else fail(`GET ${path}`, `expected 200, got ${status}`);
    } catch (error) {
      fail(`GET ${path}`, error.cause?.message ?? error.message);
    }
  }
  if (baseUrl.startsWith("https://")) {
    // fetch would have thrown on an untrusted certificate, so reaching here is the proof.
    pass("TLS certificate accepted", "GitHub will not deliver over plain HTTP");
  } else {
    skip("TLS", "URL is not https — GitHub webhooks will not be delivered");
  }
}

async function checkWebhook() {
  section("Webhook signature");
  const body = JSON.stringify({ zen: "Keep it logically awesome.", hook_id: 1 });

  try {
    const { status } = await request("/webhooks/github", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    if (status === 400) pass("unsigned delivery rejected", "400, missing headers");
    else fail("unsigned delivery rejected", `expected 400, got ${status}`);
  } catch (error) {
    fail("unsigned delivery rejected", error.cause?.message ?? error.message);
  }

  if (!secret) {
    skip("valid signature accepted", "pass --secret to run this");
    skip("wrong signature rejected", "pass --secret to run this");
    return;
  }

  try {
    const { status, text } = await request("/webhooks/github", {
      method: "POST",
      headers: signedHeaders(body, secret),
      body,
    });
    // A ping is acknowledged and ignored: the signature was verified, and nothing was cloned.
    if (status === 202 && text.includes("ignored_event_ping")) {
      pass("valid signature accepted", "202 ignored_event_ping");
    } else {
      fail(
        "valid signature accepted",
        `expected 202 ignored_event_ping, got ${status} ${text.slice(0, 80)}`,
      );
    }
  } catch (error) {
    fail("valid signature accepted", error.cause?.message ?? error.message);
  }

  try {
    const { status } = await request("/webhooks/github", {
      method: "POST",
      headers: signedHeaders(body, `${secret}x`),
      body,
    });
    if (status === 401) pass("wrong signature rejected", "401");
    else fail("wrong signature rejected", `expected 401, got ${status}`);
  } catch (error) {
    fail("wrong signature rejected", error.cause?.message ?? error.message);
  }

  // A real pull_request payload is 25-30 KB, and several things in front of an API reject a
  // body that size while happily passing a small one: AWS WAF's managed SizeRestrictions_BODY
  // rule blocks over 8 KB, and proxies have their own limits. A 1 KB ping proves nothing
  // about them, which is how a deployment ends up rejecting every real delivery with a 403
  // that never reaches the application and reads like a signature problem.
  const largeBody = JSON.stringify({ zen: "x".repeat(32 * 1024), hook_id: 1 });
  try {
    const { status, text } = await request("/webhooks/github", {
      method: "POST",
      headers: signedHeaders(largeBody, secret),
      body: largeBody,
    });
    if (status === 202) {
      pass("realistic payload size accepted", `${Math.round(largeBody.length / 1024)} KB`);
    } else {
      fail(
        "realistic payload size accepted",
        `${Math.round(largeBody.length / 1024)} KB got ${status}` +
          (status === 403 ? " — a WAF or proxy is blocking it, not the API" : "") +
          ` ${text
            .replace(/<[^>]+>/g, " ")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 70)}`,
      );
    }
  } catch (error) {
    fail("realistic payload size accepted", error.cause?.message ?? error.message);
  }
}

async function checkReadAccess() {
  section("Read access");
  try {
    const { status, text } = await request("/integrations");
    if (status === 401) {
      pass("closed to anonymous readers", "401 — no token and no public allow-list");
      return;
    }
    if (status !== 200) {
      fail("GET /integrations", `expected 200 or 401, got ${status}`);
      return;
    }
    let mode;
    try {
      // The route reports the mode but never the allow-list itself, so this confirms how
      // the API is configured without telling an anonymous caller what else to look for.
      mode = JSON.parse(text).readApi?.access;
    } catch {
      fail("GET /integrations", "response was not JSON");
      return;
    }
    if (mode === "public-allow-list") {
      pass("public dashboard read", "serving the named repositories only");
    } else if (mode === "token") {
      pass("read access", "token required");
    } else if (mode === "loopback-only") {
      fail("read access", "loopback-only, yet it answered — requests are arriving as loopback");
    } else {
      fail("GET /integrations", `unexpected readApi.access: ${String(mode)}`);
    }
  } catch (error) {
    fail("GET /integrations", error.cause?.message ?? error.message);
  }
}

async function checkApiPortClosed() {
  section("Exposure");
  if (flag("allow-open-port")) {
    skip("API port not directly reachable", "--allow-open-port");
    return;
  }
  // With a CDN in front, the public hostname is not the box, so probing it proves nothing.
  // --origin names the instance itself, which is the host whose port 3000 matters.
  const host = value("origin", new URL(baseUrl).hostname);
  if (host === "localhost" || host === "127.0.0.1") {
    skip("API port not directly reachable", "target is local");
    return;
  }
  // Behind the proxy every request looks like loopback to the API's guard, so port 3000
  // reachable from the internet means the read API is wide open regardless of the token.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(`http://${host}:3000/health/live`, { signal: controller.signal });
    fail(
      "API port not directly reachable",
      `http://${host}:3000 answered ${response.status} — close it in the security group`,
    );
  } catch {
    pass("API port not directly reachable", "3000 refused or filtered");
  } finally {
    clearTimeout(timer);
  }
}

process.stdout.write(`\n  Verifying ${baseUrl}\n`);
await checkHealth();
await checkWebhook();
await checkReadAccess();
await checkApiPortClosed();

if (failures > 0) {
  process.stdout.write(
    `\n  ${red(`${failures} check(s) failed`)}${skipped ? dim(`, ${skipped} skipped`) : ""}\n\n`,
  );
  // Not process.exit(): forcing an exit while fetch's sockets are still open aborts the
  // process on Windows with a libuv assertion instead of returning this status.
  process.exitCode = 1;
} else {
  process.stdout.write(
    `\n  ${green("All checks passed")}${skipped ? dim(`, ${skipped} skipped`) : ""}\n\n`,
  );
}
