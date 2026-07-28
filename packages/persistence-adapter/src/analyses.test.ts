import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, openDatabase, type WhyGuardDatabase } from "./database.js";
import {
  getAnalysisRun,
  getFindingById,
  getPersistedFinding,
  listAnalysisRuns,
  listFindingsForDecision,
  listFindingsForRun,
  saveScanReport,
  updateFindingLlmExplanation,
} from "./analyses.js";
import { buildTestFinding, buildTestLlmExplanation, buildTestScanReport } from "./test-helpers.js";

describe("saveScanReport / read paths", () => {
  let db: WhyGuardDatabase;

  beforeEach(() => {
    db = openDatabase(":memory:");
  });

  afterEach(() => {
    closeDatabase(db);
  });

  it("persists a scan report and makes it listable", () => {
    saveScanReport(db, buildTestScanReport());

    const runs = listAnalysisRuns(db);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      id: "run_001",
      repositoryName: "widgets",
      source: "github",
      findingCount: 1,
      highestSeverity: "critical",
    });
  });

  it("persists findings with evidence and protected properties intact", () => {
    saveScanReport(db, buildTestScanReport());

    const findings = listFindingsForRun(db, "run_001");
    expect(findings).toHaveLength(1);
    expect(findings[0]?.evidence[0]?.id).toBe("ev_issue_481");
    expect(findings[0]?.protectedProperties[0]?.statement).toBe(
      "One idempotency key creates at most one order.",
    );
    expect(findings[0]?.change.filePath).toBe("src/payments/create-order.ts");
  });

  it("derives the matching decision id from a confirmed protected property", () => {
    saveScanReport(db, buildTestScanReport());
    const findings = listFindingsForRun(db, "run_001");
    expect(findings[0]?.matchingDecisionId).toBe("payment-idempotency");
  });

  it("leaves matchingDecisionId null when no protected property is decision-confirmed", () => {
    const report = buildTestScanReport({
      findings: [
        buildTestFinding({
          protectedProperties: [
            {
              id: "pp_scan_001",
              statement: "proposed only",
              category: "correctness",
              status: "proposed",
            },
          ],
        }),
      ],
    });
    saveScanReport(db, report);
    const findings = listFindingsForRun(db, "run_001");
    expect(findings[0]?.matchingDecisionId).toBeNull();
  });

  it("is idempotent: re-saving the same run id replaces findings rather than duplicating them", () => {
    saveScanReport(db, buildTestScanReport());
    saveScanReport(db, buildTestScanReport());

    expect(listAnalysisRuns(db)).toHaveLength(1);
    expect(listFindingsForRun(db, "run_001")).toHaveLength(1);
  });

  it("stores optional pull request number and check run url", () => {
    saveScanReport(db, buildTestScanReport(), {
      pullRequestNumber: 512,
      checkRunUrl: "https://github.com/acme/widgets/runs/1",
    });

    const run = getAnalysisRun(db, "run_001");
    expect(run?.pullRequestNumber).toBe(512);
    expect(run?.checkRunUrl).toBe("https://github.com/acme/widgets/runs/1");
  });

  it("getAnalysisRun returns undefined for an unknown run id", () => {
    expect(getAnalysisRun(db, "does-not-exist")).toBeUndefined();
  });

  it("lists findings for a decision across runs", () => {
    saveScanReport(db, buildTestScanReport());
    saveScanReport(
      db,
      buildTestScanReport({
        run: { ...buildTestScanReport().run, id: "run_002" },
        findings: [buildTestFinding({ id: "fnd_002", runId: "run_002" })],
      }),
    );

    const findings = listFindingsForDecision(db, "payment-idempotency");
    expect(findings.map((f) => f.id).sort()).toEqual(["fnd_001", "fnd_002"]);
  });

  it("ranks multiple runs by createdAt descending", () => {
    saveScanReport(
      db,
      buildTestScanReport({
        run: {
          ...buildTestScanReport().run,
          id: "run_older",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
        findings: [buildTestFinding({ id: "fnd_older", runId: "run_older" })],
      }),
    );
    saveScanReport(
      db,
      buildTestScanReport({
        run: {
          ...buildTestScanReport().run,
          id: "run_newer",
          createdAt: "2026-06-01T00:00:00.000Z",
        },
        findings: [buildTestFinding({ id: "fnd_newer", runId: "run_newer" })],
      }),
    );

    const runs = listAnalysisRuns(db);
    expect(runs.map((r) => r.id)).toEqual(["run_newer", "run_older"]);
  });

  it("respects the limit parameter", () => {
    for (let i = 0; i < 5; i += 1) {
      saveScanReport(
        db,
        buildTestScanReport({
          run: { ...buildTestScanReport().run, id: `run_${i}` },
          findings: [],
        }),
      );
    }
    expect(listAnalysisRuns(db, 2)).toHaveLength(2);
  });

  describe("getPersistedFinding", () => {
    it("rebuilds a schema-valid Finding from a persisted row", () => {
      // This is what lets the MCP server resolve a finding id that came from a
      // GitHub Check or the dashboard — i.e. produced by a different process.
      saveScanReport(db, buildTestScanReport());

      const finding = getPersistedFinding(db, "fnd_001");

      expect(finding).toMatchObject({
        id: "fnd_001",
        runId: "run_001",
        severity: "critical",
      });
      expect(finding?.change.filePath).toBe("src/payments/create-order.ts");
      expect(finding?.protectedProperties[0]?.statement).toBe(
        "One idempotency key creates at most one order.",
      );
    });

    it("derives evidenceIds from the persisted evidence list", () => {
      // evidenceIds is part of the Finding contract but is not its own column, so
      // it has to be reconstructed rather than read.
      saveScanReport(db, buildTestScanReport());

      expect(getPersistedFinding(db, "fnd_001")?.evidenceIds).toEqual(["ev_issue_481"]);
    });

    it("returns undefined for an unknown finding id instead of a partial Finding", () => {
      expect(getPersistedFinding(db, "does-not-exist")).toBeUndefined();
    });
  });

  describe("llmExplanation (Phase 5)", () => {
    it("defaults llmExplanation to null before it is computed", () => {
      saveScanReport(db, buildTestScanReport());
      const findings = listFindingsForRun(db, "run_001");
      expect(findings[0]?.llmExplanation).toBeNull();
    });

    it("getFindingById returns undefined for an unknown id", () => {
      expect(getFindingById(db, "does-not-exist")).toBeUndefined();
    });

    it("persists and reads back an LLM explanation via updateFindingLlmExplanation", () => {
      saveScanReport(db, buildTestScanReport());
      const explanation = buildTestLlmExplanation({ source: "bedrock" });
      updateFindingLlmExplanation(db, "fnd_001", explanation);

      const finding = getFindingById(db, "fnd_001");
      expect(finding?.llmExplanation).toEqual(explanation);
    });

    it("overwrites a previously stored explanation rather than duplicating it", () => {
      saveScanReport(db, buildTestScanReport());
      updateFindingLlmExplanation(db, "fnd_001", buildTestLlmExplanation({ summary: "first" }));
      updateFindingLlmExplanation(db, "fnd_001", buildTestLlmExplanation({ summary: "second" }));

      expect(getFindingById(db, "fnd_001")?.llmExplanation?.summary).toBe("second");
    });

    it("re-saving a scan report clears any previously stored explanation for that run", () => {
      saveScanReport(db, buildTestScanReport());
      updateFindingLlmExplanation(db, "fnd_001", buildTestLlmExplanation());

      // saveScanReport deletes+reinserts findings for the run, so a stale
      // explanation from a prior scan must not survive a re-scan.
      saveScanReport(db, buildTestScanReport());
      expect(getFindingById(db, "fnd_001")?.llmExplanation).toBeNull();
    });
  });
});
