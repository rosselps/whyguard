import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi, beforeEach } from "vitest";
import request from "supertest";
import { WebhookDeliveryDeduplicator } from "@whyguard/github-adapter";
import type * as GitHubAdapter from "@whyguard/github-adapter";
import type { Finding, ScanReport } from "@whyguard/contracts";
import {
  closeDatabase,
  listAnalysisRuns,
  openDatabase,
  saveScanReport,
  updateFindingLlmExplanation,
  upsertDecision,
  type WhyGuardDatabase,
} from "@whyguard/persistence-adapter";
import { createServer } from "./server.js";

/**
 * Integration tests for the Express server, using simulated `pull_request` webhook
 * deliveries. Both `scanPullRequest` and the GitHub-authentication calls it depends
 * on (`createInstallationClient`, `getInstallationAccessToken`) are mocked, so these
 * tests never clone a repository, call the GitHub API, or need real GitHub App
 * credentials —.
 */

const scanPullRequestMock = vi.fn<(...args: unknown[]) => Promise<unknown>>();

vi.mock("@whyguard/application", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@whyguard/application");
  return {
    ...actual,
    scanPullRequest: (...args: unknown[]) => scanPullRequestMock(...args),
  };
});

// The real WebhookDeliveryDeduplicator is a pure in-memory class with no I/O, so it
// is reused as-is; only the network-touching auth helpers are stubbed.
vi.mock("@whyguard/github-adapter", async () => {
  const actual = await vi.importActual<typeof GitHubAdapter>("@whyguard/github-adapter");
  return {
    ...actual,
    createInstallationClient: vi.fn(() => ({}) as never),
    getInstallationAccessToken: vi.fn(() => Promise.resolve("fake-installation-token")),
    buildInstallationCloneUrl: actual.buildInstallationCloneUrl,
  };
});

const credentials = { appId: "1", privateKey: "test-private-key" };
const webhookSecret = "test-webhook-secret";

function sign(payload: string): string {
  return `sha256=${createHmac("sha256", webhookSecret).update(payload).digest("hex")}`;
}

function pullRequestPayload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    action: "opened",
    number: 493,
    installation: { id: 12345 },
    repository: { name: "whyguard-demo", owner: { login: "demo-org" } },
    ...overrides,
  });
}

function fakeScanReport(overrides: Partial<ScanReport> = {}): ScanReport {
  return {
    schemaVersion: 1,
    run: {
      id: "run_001",
      repository: { provider: "github", owner: "demo-org", name: "whyguard-demo" },
      baseSha: "aaaaaaaaaaaa",
      headSha: "bbbbbbbbbbbb",
      source: "github",
      status: "completed",
      createdAt: "2026-07-01T00:00:00.000Z",
    },
    findings: [],
    llmEnabled: false,
    ...overrides,
  };
}

function fakeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: "fnd_001",
    runId: "run_001",
    change: {
      id: "chg_001",
      filePath: "src/payments/create-order.ts",
      symbol: "createOrder",
      kind: "condition_removed",
      lines: { start: 10, end: 20 },
    },
    evidenceIds: ["ev_issue_481"],
    evidence: [
      { id: "ev_issue_481", type: "issue", title: "Duplicate orders on retry", strength: "strong" },
    ],
    protectedProperties: [
      {
        id: "pp_decision_payment-idempotency_0",
        statement: "One idempotency key creates at most one order.",
        category: "business_rule",
        status: "confirmed",
      },
    ],
    riskScore: 91,
    confidenceScore: 88,
    severity: "critical",
    reasonStatus: "known",
    explanation: "test explanation",
    recommendation: "test recommendation",
    ...overrides,
  };
}

describe("createServer", () => {
  beforeEach(() => {
    scanPullRequestMock.mockReset();
    scanPullRequestMock.mockResolvedValue({
      report: fakeScanReport(),
      checkRun: { id: 1, htmlUrl: "https://github.com/demo-org/whyguard-demo/runs/1" },
      decisions: [],
    });
  });

  it("responds 200 on /health/live and /health/ready", async () => {
    const app = createServer({ credentials, webhookSecret });
    const live = await request(app).get("/health/live");
    const ready = await request(app).get("/health/ready");
    expect(live.status).toBe(200);
    expect(ready.status).toBe(200);
  });

  it("rejects a webhook request with an invalid signature", async () => {
    const app = createServer({ credentials, webhookSecret });
    const body = pullRequestPayload();
    const res = await request(app)
      .post("/webhooks/github")
      .set("X-GitHub-Delivery", "delivery-1")
      .set("X-GitHub-Event", "pull_request")
      .set("X-Hub-Signature-256", "sha256=deadbeef")
      .set("Content-Type", "application/json")
      .send(body);
    expect(res.status).toBe(401);
  });

  it("rejects a webhook request missing required headers", async () => {
    const app = createServer({ credentials, webhookSecret });
    const body = pullRequestPayload();
    const res = await request(app)
      .post("/webhooks/github")
      .set("X-Hub-Signature-256", sign(body))
      .set("Content-Type", "application/json")
      .send(body);
    expect(res.status).toBe(400);
  });

  it("accepts a valid pull_request.opened webhook and dispatches the scan", async () => {
    const app = createServer({ credentials, webhookSecret });
    const body = pullRequestPayload({ action: "opened" });
    const res = await request(app)
      .post("/webhooks/github")
      .set("X-GitHub-Delivery", "delivery-1")
      .set("X-GitHub-Event", "pull_request")
      .set("X-Hub-Signature-256", sign(body))
      .set("Content-Type", "application/json")
      .send(body);

    expect(res.status).toBe(202);
    // Dispatch happens after the response is sent; give the microtask queue a turn.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(scanPullRequestMock).toHaveBeenCalledTimes(1);
  });

  it("acknowledges but does not dispatch a pull_request.closed webhook", async () => {
    const app = createServer({ credentials, webhookSecret });
    const body = pullRequestPayload({ action: "closed" });
    const res = await request(app)
      .post("/webhooks/github")
      .set("X-GitHub-Delivery", "delivery-2")
      .set("X-GitHub-Event", "pull_request")
      .set("X-Hub-Signature-256", sign(body))
      .set("Content-Type", "application/json")
      .send(body);

    expect(res.status).toBe(202);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(scanPullRequestMock).not.toHaveBeenCalled();
  });

  it("ignores non-pull_request events with a 202", async () => {
    const app = createServer({ credentials, webhookSecret });
    const body = JSON.stringify({ zen: "Non-blocking is better than blocking." });
    const res = await request(app)
      .post("/webhooks/github")
      .set("X-GitHub-Delivery", "delivery-3")
      .set("X-GitHub-Event", "ping")
      .set("X-Hub-Signature-256", sign(body))
      .set("Content-Type", "application/json")
      .send(body);

    expect(res.status).toBe(202);
    expect(scanPullRequestMock).not.toHaveBeenCalled();
  });

  it("rejects a replayed delivery id as a duplicate", async () => {
    const deduplicator = new WebhookDeliveryDeduplicator();
    const app = createServer({ credentials, webhookSecret, deduplicator });
    const body = pullRequestPayload({ action: "opened" });

    const first = await request(app)
      .post("/webhooks/github")
      .set("X-GitHub-Delivery", "delivery-replay")
      .set("X-GitHub-Event", "pull_request")
      .set("X-Hub-Signature-256", sign(body))
      .set("Content-Type", "application/json")
      .send(body);
    expect(first.status).toBe(202);
    await new Promise((resolve) => setTimeout(resolve, 10));

    const second = await request(app)
      .post("/webhooks/github")
      .set("X-GitHub-Delivery", "delivery-replay")
      .set("X-GitHub-Event", "pull_request")
      .set("X-Hub-Signature-256", sign(body))
      .set("Content-Type", "application/json")
      .send(body);
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ status: "duplicate_ignored" });
    expect(scanPullRequestMock).toHaveBeenCalledTimes(1);
  });

  describe("persistence (Phase 5)", () => {
    let db: WhyGuardDatabase;

    beforeEach(() => {
      db = openDatabase(":memory:");
    });

    afterEach(() => {
      closeDatabase(db);
    });

    it("saves the scan report when a database handle is provided", async () => {
      const app = createServer({ credentials, webhookSecret, db });
      const body = pullRequestPayload({ action: "opened" });
      const res = await request(app)
        .post("/webhooks/github")
        .set("X-GitHub-Delivery", "delivery-persist-1")
        .set("X-GitHub-Event", "pull_request")
        .set("X-Hub-Signature-256", sign(body))
        .set("Content-Type", "application/json")
        .send(body);

      expect(res.status).toBe(202);
      await new Promise((resolve) => setTimeout(resolve, 10));

      const runs = listAnalysisRuns(db);
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({
        id: "run_001",
        pullRequestNumber: 493,
        checkRunUrl: "https://github.com/demo-org/whyguard-demo/runs/1",
      });
    });

    it("does not attempt to persist anything when no database handle is provided", async () => {
      const app = createServer({ credentials, webhookSecret });
      const body = pullRequestPayload({ action: "opened" });
      const res = await request(app)
        .post("/webhooks/github")
        .set("X-GitHub-Delivery", "delivery-no-db")
        .set("X-GitHub-Event", "pull_request")
        .set("X-Hub-Signature-256", sign(body))
        .set("Content-Type", "application/json")
        .send(body);

      // No assertion possible against a database that was never opened; this only
      // confirms the request still completes normally without one.
      expect(res.status).toBe(202);
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  });

  describe("read endpoints (Phase 5)", () => {
    let db: WhyGuardDatabase;

    beforeEach(() => {
      db = openDatabase(":memory:");
    });

    afterEach(() => {
      closeDatabase(db);
    });

    function seedReportAndDecision(): void {
      saveScanReport(db, fakeScanReport({ findings: [] }));
      upsertDecision(db, {
        contract: {
          id: "payment-idempotency",
          version: 1,
          status: "active",
          scope: { files: ["src/payments/create-order.ts"] },
          reason: "Prevent duplicate orders on retry.",
          must_preserve: ["One idempotency key creates at most one order."],
          evidence: [{ type: "issue", id: "481" }],
          required_tests: [],
          expires_when: [],
          owners: ["payments-team"],
        },
      });
    }

    /**
     * The public allow-list is what makes a deployed dashboard safe to link publicly, so
     * these assert the boundary rather than the happy path: a caller with no credential
     * must see the named repository and nothing else, and must not be able to tell
     * whether an id it cannot read exists at all.
     *
     * Reaching "public" mode from supertest takes a configured token and no
     * Authorization header — every request here originates from loopback, and loopback
     * deliberately stops being sufficient once a token exists.
     */
    describe("public allow-list", () => {
      const publicRepositories = ["demo-org/whyguard-demo"];
      const apiToken = "test-token";

      function seedTwoRepositories(): void {
        saveScanReport(db, fakeScanReport({ findings: [fakeFinding()] }));
        saveScanReport(
          db,
          fakeScanReport({
            run: {
              ...fakeScanReport().run,
              id: "run_private",
              repository: { provider: "github", owner: "acme", name: "internal-billing" },
            },
            findings: [fakeFinding({ id: "fnd_private", runId: "run_private" })],
          }),
        );
      }

      it("lists only the allow-listed repository", async () => {
        seedTwoRepositories();
        const app = createServer({ credentials, webhookSecret, db, apiToken, publicRepositories });

        const res = await request(app).get("/reports");

        expect(res.status).toBe(200);
        // A run row stores only the bare repository name, which is exactly why the
        // allow-list is matched on the repository id instead — see `publicRepositoryIds`.
        const names = (res.body as { repositoryName: string }[]).map((r) => r.repositoryName);
        expect(names).toEqual(["whyguard-demo"]);
      });

      it("answers 404, not 403, for a report outside the list", async () => {
        // 403 would confirm the id exists, turning the endpoint into an oracle for
        // enumerating private repositories one id at a time.
        seedTwoRepositories();
        const app = createServer({ credentials, webhookSecret, db, apiToken, publicRepositories });

        const allowed = await request(app).get("/reports/run_001");
        const hidden = await request(app).get("/reports/run_private");

        expect(allowed.status).toBe(200);
        expect(hidden.status).toBe(404);
      });

      it("hides a finding whose run is outside the list", async () => {
        seedTwoRepositories();
        const app = createServer({ credentials, webhookSecret, db, apiToken, publicRepositories });

        const res = await request(app).get("/findings/fnd_private/regression-test");

        expect(res.status).toBe(404);
      });

      it("serves everything to a caller presenting the token", async () => {
        seedTwoRepositories();
        const app = createServer({ credentials, webhookSecret, db, apiToken, publicRepositories });

        const res = await request(app).get("/reports").set("Authorization", `Bearer ${apiToken}`);

        expect(res.status).toBe(200);
        expect(res.body).toHaveLength(2);
      });

      it("counts only readable analyses in the summary", async () => {
        seedTwoRepositories();
        const app = createServer({ credentials, webhookSecret, db, apiToken, publicRepositories });

        const res = await request(app).get("/summary");

        expect(res.status).toBe(200);
        expect((res.body as { totalAnalyses: number }).totalAnalyses).toBe(1);
      });

      it("reports the mode on /integrations so an operator can see it is live", async () => {
        const app = createServer({ credentials, webhookSecret, db, apiToken, publicRepositories });

        const res = await request(app).get("/integrations");

        expect(res.status).toBe(200);
        expect((res.body as { readApi: { access: string } }).readApi.access).toBe(
          "public-allow-list",
        );
      });
    });

    it("GET /reports returns [] when no reports exist", async () => {
      const app = createServer({ credentials, webhookSecret, db });
      const res = await request(app).get("/reports");
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    it("GET /reports lists a saved report without requiring db access outside routes", async () => {
      seedReportAndDecision();
      const app = createServer({ credentials, webhookSecret, db });
      const res = await request(app).get("/reports");
      expect(res.status).toBe(200);
      const body = res.body as unknown[];
      expect(body).toHaveLength(1);
      expect(body[0]).toMatchObject({ id: "run_001", findingCount: 0 });
    });

    it("GET /reports/:id returns 404 for an unknown id", async () => {
      const app = createServer({ credentials, webhookSecret, db });
      const res = await request(app).get("/reports/does-not-exist");
      expect(res.status).toBe(404);
    });

    it("GET /reports/:id returns report detail with findings", async () => {
      seedReportAndDecision();
      const app = createServer({ credentials, webhookSecret, db });
      const res = await request(app).get("/reports/run_001");
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ id: "run_001", findings: [] });
    });

    it("GET /decisions/:id returns 404 for an unknown id", async () => {
      const app = createServer({ credentials, webhookSecret, db });
      const res = await request(app).get("/decisions/does-not-exist");
      expect(res.status).toBe(404);
    });

    it("GET /decisions/:id returns decision detail with linked findings", async () => {
      seedReportAndDecision();
      const app = createServer({ credentials, webhookSecret, db });
      const res = await request(app).get("/decisions/payment-idempotency");
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        id: "payment-idempotency",
        mustPreserve: ["One idempotency key creates at most one order."],
        linkedFindings: [],
      });
    });

    it("does not register read routes at all when no db is configured", async () => {
      const app = createServer({ credentials, webhookSecret });
      const res = await request(app).get("/reports");
      expect(res.status).toBe(404);
    });

    it("reflects Access-Control-Allow-Origin for the default dashboard origin", async () => {
      const app = createServer({ credentials, webhookSecret, db });
      const res = await request(app).get("/reports").set("Origin", "http://localhost:5173");
      expect(res.headers["access-control-allow-origin"]).toBe("http://localhost:5173");
    });

    it("does not reflect Access-Control-Allow-Origin for an unlisted origin", async () => {
      const app = createServer({ credentials, webhookSecret, db });
      const res = await request(app).get("/reports").set("Origin", "https://evil.example");
      expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    });

    it("GET /reports/:id includes llmExplanation as null before it is computed", async () => {
      saveScanReport(db, fakeScanReport({ findings: [fakeFinding()] }));
      const app = createServer({ credentials, webhookSecret, db });
      const res = await request(app).get("/reports/run_001");
      expect(res.status).toBe(200);
      const body = res.body as { findings: { llmExplanation: unknown }[] };
      expect(body.findings[0]?.llmExplanation).toBeNull();
    });

    it("GET /reports/:id includes a computed llmExplanation once persisted", async () => {
      saveScanReport(db, fakeScanReport({ findings: [fakeFinding()] }));
      updateFindingLlmExplanation(db, "fnd_001", {
        summary: "test summary",
        protectedProperty: "One idempotency key creates at most one order.",
        recommendation: "test recommendation",
        usedEvidenceIds: ["ev_issue_481"],
        uncertainty: "test uncertainty",
        source: "fallback",
        generatedAt: "2026-07-01T00:00:00.000Z",
      });
      const app = createServer({ credentials, webhookSecret, db });
      const res = await request(app).get("/reports/run_001");
      expect(res.status).toBe(200);
      const body = res.body as { findings: { llmExplanation: { source: string } }[] };
      expect(body.findings[0]?.llmExplanation?.source).toBe("fallback");
    });

    it("GET /findings/:id/regression-test returns 404 for an unknown finding", async () => {
      const app = createServer({ credentials, webhookSecret, db });
      const res = await request(app).get("/findings/does-not-exist/regression-test");
      expect(res.status).toBe(404);
    });

    it("GET /findings/:id/regression-test returns a deterministic vitest skeleton by default", async () => {
      saveScanReport(db, fakeScanReport({ findings: [fakeFinding()] }));
      const app = createServer({ credentials, webhookSecret, db });
      const res = await request(app).get("/findings/fnd_001/regression-test");
      expect(res.status).toBe(200);
      const body = res.body as { framework: string; filePath: string; code: string };
      expect(body).toMatchObject({
        framework: "vitest",
        filePath: "src/payments/create-order.regression.test.ts",
      });
      expect(body.code).toContain("createOrder");
      expect(body.code).toContain("it.todo");
    });

    it("GET /findings/:id/regression-test honors the framework query param", async () => {
      saveScanReport(db, fakeScanReport({ findings: [fakeFinding()] }));
      const app = createServer({ credentials, webhookSecret, db });
      const res = await request(app).get("/findings/fnd_001/regression-test?framework=jest");
      expect(res.status).toBe(200);
      const body = res.body as { framework: string };
      expect(body.framework).toBe("jest");
    });
  });
});
