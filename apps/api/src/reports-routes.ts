import type { Router, Request, Response } from "express";
import { Router as createRouter } from "express";
import {
  getAnalysisRun,
  getDecision,
  getFindingById,
  getLastGithubAnalysisAt,
  getSummaryCounts,
  listAnalysisRuns,
  listFindingsForDecision,
  listFindingsForRun,
  repositoryId,
  type FindingRow,
  type SummaryCounts,
  type WhyGuardDatabase,
} from "@whyguard/persistence-adapter";
import { buildRegressionTestProposal } from "@whyguard/application";
import type {
  AnalysisRunDetail,
  AnalysisRunFindingWithExplanation,
  AnalysisRunSummary,
  DecisionDetail,
  Finding,
} from "@whyguard/contracts";
import {
  AnalysisRunDetailSchema,
  AnalysisRunSummarySchema,
  DashboardSummarySchema,
  DecisionDetailSchema,
  IntegrationsStatusSchema,
  RegressionTestProposalSchema,
} from "@whyguard/contracts";
import { logError } from "./logger.js";
import { accessModeOf } from "./security.js";

/**
 * How many recent runs a public caller's `/summary` is computed from.
 *
 * Bounded because that path reads the findings of every run it counts, unlike the
 * single-query global aggregate. A ceiling keeps one unauthenticated request from
 * turning into an unbounded scan of the whole table.
 */
const SUMMARY_RUN_LIMIT = 200;

/**
 * Read-only dashboard API routes and
 * `.kiro/steering/ui-ux.md`'s route table (`/`, `/analyses/:id`,
 * `/decisions/:id`). These endpoints only ever read from
 * `packages/persistence-adapter` — they never trigger a scan or touch Git/GitHub,
 * unlike `POST /webhooks/github`.
 *
 * Every response is validated against its Zod schema in `@whyguard/contracts`
 * before being sent, so a persistence-layer shape drift fails loudly here
 * instead of silently reaching the dashboard.
 */

function toAnalysisRunSummaryDto(
  row: ReturnType<typeof listAnalysisRuns>[number],
): AnalysisRunSummary {
  return AnalysisRunSummarySchema.parse({
    id: row.id,
    repositoryName: row.repositoryName,
    baseSha: row.baseSha,
    headSha: row.headSha,
    source: row.source,
    status: row.status,
    createdAt: row.createdAt,
    llmEnabled: row.llmEnabled,
    pullRequestNumber: row.pullRequestNumber,
    checkRunUrl: row.checkRunUrl,
    findingCount: row.findingCount,
    highestSeverity: row.highestSeverity,
  });
}

function toFindingDto(row: FindingRow): AnalysisRunFindingWithExplanation {
  return {
    id: row.id,
    runId: row.runId,
    change: row.change,
    severity: row.severity as AnalysisRunFindingWithExplanation["severity"],
    riskScore: row.riskScore,
    confidenceScore: row.confidenceScore,
    reasonStatus: row.reasonStatus as AnalysisRunFindingWithExplanation["reasonStatus"],
    explanation: row.explanation,
    recommendation: row.recommendation,
    matchingDecisionId: row.matchingDecisionId,
    regressionTestStatus: row.regressionTestStatus,
    evidence: row.evidence,
    protectedProperties: row.protectedProperties,
    llmExplanation: row.llmExplanation,
  };
}

/**
 * Converts a persisted `FindingRow` back into the full domain `Finding` shape
 * `buildRegressionTestProposal` (from `@whyguard/application`) expects. Only
 * used by the regression-test route below — the read routes above use the
 * lighter `AnalysisRunFindingWithExplanation` DTO instead. `evidenceIds` is
 * reconstructed from `evidence` since `FindingRow` doesn't store it
 * separately (it's redundant with `evidence[].id`).
 */
function toFinding(row: FindingRow): Finding {
  return {
    id: row.id,
    runId: row.runId,
    change: row.change,
    evidenceIds: row.evidence.map((item) => item.id),
    evidence: row.evidence,
    protectedProperties: row.protectedProperties,
    riskScore: row.riskScore,
    confidenceScore: row.confidenceScore,
    severity: row.severity as Finding["severity"],
    reasonStatus: row.reasonStatus as Finding["reasonStatus"],
    explanation: row.explanation,
    recommendation: row.recommendation,
  };
}

export type ReportsRouterOptions = {
  /** Whether GitHub App credentials loaded successfully. */
  githubCredentialsConfigured: boolean;
  /** Which explanation path is actually in use. */
  explanationSource: "bedrock" | "fallback";
  /** How the read API is reachable, for the integrations screen. */
  readApiAccess: "token" | "loopback-only" | "public-allow-list";
  /** Repositories, as `owner/repo`, readable without a credential. See `apiTokenGuard`. */
  publicRepositories?: string[];
};

export function createReportsRouter(db: WhyGuardDatabase, options: ReportsRouterOptions): Router {
  const router = createRouter();
  /**
   * The allow-list, resolved to the stable repository ids actually stored on a run.
   *
   * Matching on the id rather than on `repositoryName` is what makes this an access
   * control instead of a coincidence: a run row's `repositoryName` is only the bare
   * name, so `acme/demo` and `evil/demo` would be indistinguishable. `repositoryId`
   * encodes provider, owner and name, so an entry authorizes exactly one repository.
   *
   * A side effect worth stating: only GitHub-sourced analyses can be made public,
   * because a locally scanned run has no owner. That is the right default — local runs
   * are keyed on a filesystem path.
   */
  const publicRepositoryIds = new Set(
    (options.publicRepositories ?? [])
      .map((entry) => entry.trim().split("/"))
      .filter((parts): parts is [string, string] => parts.length === 2 && Boolean(parts[1]))
      .map(([owner, name]) => repositoryId({ provider: "github", owner, name })),
  );

  /**
   * Whether this request may see analyses of a repository.
   *
   * Token and loopback callers see everything. A public caller sees only the named
   * repositories, enforced here rather than in the guard because the guard runs before
   * anything knows which repository a request will touch.
   */
  const canRead = (res: Response, run: { repositoryId: string }): boolean => {
    if (accessModeOf(res) !== "public") return true;
    return publicRepositoryIds.has(run.repositoryId);
  };

  /** Runs this request is allowed to see, newest first. */
  const readableRuns = (res: Response, limit?: number): ReturnType<typeof listAnalysisRuns> =>
    listAnalysisRuns(db, limit).filter((run) => canRead(res, run));

  /** A finding inherits its repository from the run that produced it. */
  const canReadFinding = (res: Response, finding: FindingRow): boolean => {
    if (accessModeOf(res) !== "public") return true;
    const run = getAnalysisRun(db, finding.runId);
    return run ? canRead(res, run) : false;
  };

  /**
   * A public caller gets 404, not 403, for a repository outside the allow-list.
   *
   * 403 would confirm that the id exists, which turns the endpoint into an oracle for
   * enumerating private repositories one run id at a time.
   */
  const notFound = (res: Response, what: string, id: string): void => {
    res.status(404).json({ error: `No ${what} found with id "${id}".` });
  };

  /** Recomputes the overview counts over a subset of runs. See `GET /summary`. */
  const summarizeRuns = (runs: ReturnType<typeof listAnalysisRuns>): SummaryCounts => {
    const findings = runs.flatMap((run) => listFindingsForRun(db, run.id));
    return {
      totalAnalyses: runs.length,
      // Decisions carry no repository, so a public caller is told how many of them are
      // actually cited by the analyses it can see rather than the global total.
      activeDecisions: new Set(
        findings.map((finding) => finding.matchingDecisionId).filter(Boolean),
      ).size,
      highRiskFindings: findings.filter((f) => f.severity === "high" || f.severity === "critical")
        .length,
      findingsWithoutTest: findings.filter((f) => f.regressionTestStatus === "missing").length,
      unknownReasonFindings: findings.filter((f) => f.reasonStatus === "unknown").length,
    };
  };

  router.get("/integrations", (_req: Request, res: Response) => {
    try {
      res.status(200).json(
        IntegrationsStatusSchema.parse({
          github: {
            credentialsConfigured: options.githubCredentialsConfigured,
            lastWebhookAnalysisAt: getLastGithubAnalysisAt(db),
          },
          explanations: { source: options.explanationSource },
          readApi: { access: options.readApiAccess },
        }),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logError("GET /integrations failed", { message });
      res.status(500).json({ error: "Failed to load integration status." });
    }
  });

  router.get("/summary", (_req: Request, res: Response) => {
    try {
      // The global SQL aggregate is only correct for a caller allowed to see every
      // repository. A public caller's totals are recomputed over the runs it may read,
      // which is slower but cannot report counts drawn from repositories it cannot open.
      const summary =
        accessModeOf(res) === "public"
          ? summarizeRuns(readableRuns(res, SUMMARY_RUN_LIMIT))
          : getSummaryCounts(db);
      res.status(200).json(DashboardSummarySchema.parse(summary));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logError("GET /summary failed", { message });
      res.status(500).json({ error: "Failed to load summary." });
    }
  });

  router.get("/reports", (req: Request, res: Response) => {
    try {
      const limitParam = req.query.limit;
      const limit =
        typeof limitParam === "string" && /^\d+$/.test(limitParam)
          ? Math.min(Number(limitParam), 200)
          : undefined;
      const body = readableRuns(res, limit).map(toAnalysisRunSummaryDto);
      res.status(200).json(body);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logError("GET /reports failed", { message });
      res.status(500).json({ error: "Failed to list reports." });
    }
  });

  router.get("/reports/:id", (req: Request, res: Response) => {
    const id = String(req.params.id);
    try {
      const run = getAnalysisRun(db, id);
      if (!run || !canRead(res, run)) {
        notFound(res, "report", id);
        return;
      }
      const findings = listFindingsForRun(db, id).map(toFindingDto);
      const detail: AnalysisRunDetail = { ...toAnalysisRunSummaryDto(run), findings };
      res.status(200).json(AnalysisRunDetailSchema.parse(detail));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logError("GET /reports/:id failed", { id, message });
      res.status(500).json({ error: "Failed to load report." });
    }
  });

  router.get("/findings/:id/regression-test", (req: Request, res: Response) => {
    const id = String(req.params.id);
    const framework = typeof req.query.framework === "string" ? req.query.framework : "vitest";
    try {
      const row = getFindingById(db, id);
      if (!row || !canReadFinding(res, row)) {
        notFound(res, "finding", id);
        return;
      }
      // Deterministic-only rule
      // 9: this is a template, never executed by WhyGuard, and this route
      // never triggers an LLM call — it always uses the same fallback
      // template `explainFinding`'s deterministic path uses.
      const proposal = buildRegressionTestProposal(toFinding(row), framework);
      res.status(200).json(RegressionTestProposalSchema.parse(proposal));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logError("GET /findings/:id/regression-test failed", { id, message });
      res.status(500).json({ error: "Failed to build regression test proposal." });
    }
  });

  router.get("/decisions/:id", (req: Request, res: Response) => {
    const id = String(req.params.id);
    try {
      const decision = getDecision(db, id);
      if (!decision) {
        notFound(res, "decision", id);
        return;
      }
      const linked = listFindingsForDecision(db, id);
      // A decision row carries no repository of its own, so for a public caller
      // reachability is derived: it may read the decision only if one of the findings
      // citing it belongs to an allowed repository. A decision with no findings at all
      // is still perfectly readable by a token or loopback caller.
      const readable = linked.filter((finding) => canReadFinding(res, finding));
      if (accessModeOf(res) === "public" && readable.length === 0) {
        notFound(res, "decision", id);
        return;
      }
      const linkedFindings = readable.map(toFindingDto);
      const detail: DecisionDetail = {
        id: decision.id,
        version: decision.version,
        status: decision.status,
        reason: decision.reason,
        owners: decision.owners,
        scope: decision.scope,
        mustPreserve: decision.mustPreserve,
        evidence: decision.evidence,
        requiredTests: decision.requiredTests,
        sourcePath: decision.sourcePath,
        updatedAt: decision.updatedAt,
        linkedFindings,
      };
      res.status(200).json(DecisionDetailSchema.parse(detail));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logError("GET /decisions/:id failed", { id, message });
      res.status(500).json({ error: "Failed to load decision." });
    }
  });

  return router;
}
