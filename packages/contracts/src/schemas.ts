import { z } from "zod";

/**
 * Shared DTOs and validation schemas for WhyGuard.
 * Mirrors the domain model defined in.
 * Any DTO crossing a package/process boundary must be defined and validated here.
 */

export const RepositoryRefSchema = z.object({
  provider: z.enum(["github", "local"]),
  owner: z.string().min(1).optional(),
  name: z.string().min(1),
  root: z.string().min(1).optional(),
});
export type RepositoryRef = z.infer<typeof RepositoryRefSchema>;

export const AnalysisRunSchema = z.object({
  id: z.string().min(1),
  repository: RepositoryRefSchema,
  baseSha: z.string().min(4),
  headSha: z.string().min(4),
  source: z.enum(["github", "cli", "kiro"]),
  status: z.enum(["queued", "running", "completed", "failed"]),
  createdAt: z.string().min(1),
});
export type AnalysisRun = z.infer<typeof AnalysisRunSchema>;

export const SensitiveChangeKindSchema = z.enum([
  "condition_removed",
  "boundary_changed",
  "retry_removed",
  "timeout_changed",
  "validation_removed",
  "special_case_removed",
  "test_removed",
]);
export type SensitiveChangeKind = z.infer<typeof SensitiveChangeKindSchema>;

export const SensitiveChangeSchema = z.object({
  id: z.string().min(1),
  filePath: z.string().min(1),
  symbol: z.string().optional(),
  kind: SensitiveChangeKindSchema,
  before: z.string().optional(),
  after: z.string().optional(),
  lines: z.object({ start: z.number().int().nonnegative(), end: z.number().int().nonnegative() }),
});
export type SensitiveChange = z.infer<typeof SensitiveChangeSchema>;

export const EvidenceStrengthSchema = z.enum(["strong", "medium", "weak"]);
export type EvidenceStrength = z.infer<typeof EvidenceStrengthSchema>;

export const EvidenceSchema = z.object({
  id: z.string().min(1),
  type: z.enum(["commit", "pull_request", "issue", "comment", "test", "code"]),
  title: z.string().min(1),
  summary: z.string().optional(),
  url: z.string().optional(),
  sha: z.string().optional(),
  strength: EvidenceStrengthSchema,
});
export type Evidence = z.infer<typeof EvidenceSchema>;

export const ProtectedPropertySchema = z.object({
  id: z.string().min(1),
  statement: z.string().min(1),
  category: z.enum(["safety", "correctness", "compatibility", "business_rule"]),
  status: z.enum(["proposed", "confirmed", "replaced", "expired"]),
});
export type ProtectedProperty = z.infer<typeof ProtectedPropertySchema>;

export const RegressionTestProposalSchema = z.object({
  framework: z.string().min(1),
  filePath: z.string().min(1),
  code: z.string().min(1),
});
export type RegressionTestProposal = z.infer<typeof RegressionTestProposalSchema>;

export const SeveritySchema = z.enum(["low", "medium", "high", "critical"]);
export type Severity = z.infer<typeof SeveritySchema>;

export const ReasonStatusSchema = z.enum(["known", "unknown"]);
export type ReasonStatus = z.infer<typeof ReasonStatusSchema>;

export const FindingSchema = z.object({
  id: z.string().min(1),
  runId: z.string().min(1),
  change: SensitiveChangeSchema,
  evidenceIds: z.array(z.string().min(1)),
  evidence: z.array(EvidenceSchema),
  protectedProperties: z.array(ProtectedPropertySchema),
  riskScore: z.number().min(0).max(100),
  confidenceScore: z.number().min(0).max(100),
  severity: SeveritySchema,
  reasonStatus: ReasonStatusSchema,
  explanation: z.string().min(1),
  recommendation: z.string().min(1),
  regressionTest: RegressionTestProposalSchema.optional(),
});
export type Finding = z.infer<typeof FindingSchema>;

export const ScanReportSchema = z.object({
  schemaVersion: z.literal(1),
  run: AnalysisRunSchema,
  findings: z.array(FindingSchema),
  llmEnabled: z.boolean(),
});
export type ScanReport = z.infer<typeof ScanReportSchema>;

/**
 * Rationale contract schema, mirroring the `.whyguard/decisions/*.yml` shape from
 *. A rationale contract is a human-confirmed
 * decision that documents a protected behavior so future scans don't have to
 * re-derive it from history every time.
 */
export const RationaleContractEvidenceRefSchema = z.object({
  type: z.enum(["issue", "pull_request", "commit", "comment", "test", "code"]),
  id: z.string().min(1),
});
export type RationaleContractEvidenceRef = z.infer<typeof RationaleContractEvidenceRefSchema>;

export const RationaleContractSchema = z.object({
  id: z.string().min(1),
  version: z.number().int().positive(),
  status: z.enum(["draft", "active", "replaced", "expired"]),
  scope: z.object({
    files: z.array(z.string().min(1)).min(1),
    symbols: z.array(z.string().min(1)).optional(),
  }),
  reason: z.string().min(1),
  must_preserve: z.array(z.string().min(1)).min(1),
  evidence: z.array(RationaleContractEvidenceRefSchema).default([]),
  required_tests: z.array(z.string().min(1)).default([]),
  expires_when: z.array(z.string().min(1)).default([]),
  owners: z.array(z.string().min(1)).default([]),
});
export type RationaleContract = z.infer<typeof RationaleContractSchema>;

/** Validates and returns a RationaleContract, or throws a ZodError with details. */
export function parseRationaleContract(input: unknown): RationaleContract {
  return RationaleContractSchema.parse(input);
}

/** Validates and returns a Finding, or throws a ZodError with details. */
export function parseFinding(input: unknown): Finding {
  return FindingSchema.parse(input);
}

/** Validates and returns a ScanReport, or throws a ZodError with details. */
export function parseScanReport(input: unknown): ScanReport {
  return ScanReportSchema.parse(input);
}

/**
 * Result of `whyguard trace <file>:<symbol>` — a lightweight decision lineage: the confirmed rationale
 * contract for the symbol (if any), the evidence gathered from history, and the
 * recent commit history touching the file.
 */
export const TraceCommitSchema = z.object({
  sha: z.string().min(1),
  subject: z.string(),
  authorName: z.string(),
  date: z.string(),
});
export type TraceCommit = z.infer<typeof TraceCommitSchema>;

export const TraceResultSchema = z.object({
  filePath: z.string().min(1),
  symbol: z.string().optional(),
  reasonStatus: ReasonStatusSchema,
  protectedProperties: z.array(ProtectedPropertySchema),
  evidence: z.array(EvidenceSchema),
  history: z.array(TraceCommitSchema),
  matchingDecisionId: z.string().optional(),
});
export type TraceResult = z.infer<typeof TraceResultSchema>;

/** Validates and returns a TraceResult, or throws a ZodError with details. */
export function parseTraceResult(input: unknown): TraceResult {
  return TraceResultSchema.parse(input);
}

/**
 * `whyguard guard --stdin` request contract. This is a WhyGuard-owned contract, not Kiro's raw
 * hook event payload — the exact shape Kiro sends to a `command` hook is not fixed
 * by this document, so a thin adapter (or the hook command itself) is expected to
 * translate a real Kiro tool-call event into this shape before piping it to
 * `whyguard guard --stdin`.
 */
export const GuardRequestSchema = z.object({
  /** Repository root. Defaults to the CLI's current working directory if omitted. */
  repoRoot: z.string().min(1).optional(),
  filePath: z.string().min(1),
  /** The proposed new file content. `null` means the tool call would delete the file. */
  afterContent: z.string().nullable(),
  /**
   * The file's current content. If omitted, the CLI reads it from disk at
   * `<repoRoot>/<filePath>`; use `null` explicitly to mean "file does not exist yet".
   */
  beforeContent: z.string().nullable().optional(),
});
export type GuardRequest = z.infer<typeof GuardRequestSchema>;

/** Validates and returns a GuardRequest, or throws a ZodError with details. */
export function parseGuardRequest(input: unknown): GuardRequest {
  return GuardRequestSchema.parse(input);
}

/**
 * Read-model DTOs for the Phase 5 dashboard API (`apps/api`'s `GET /reports` and
 * `GET /decisions/:id` routes; see and
 * `.kiro/steering/ui-ux.md`). These are deliberately separate from `ScanReport`/
 * `RationaleContract` above: they describe what `packages/persistence-adapter`
 * returns after joining/aggregating rows (finding counts, highest severity), not
 * what a scan produces in-process.
 */
/**
 * Aggregate counts for the dashboard's overview screen.
 *
 * `unknownReasonFindings` is part of the contract on purpose: UI
 * principle is to show "unknown" explicitly rather than hide weak evidence, so the
 * count of findings WhyGuard could not explain is a first-class number, not something
 * to omit because it looks bad.
 */
export const DashboardSummarySchema = z.object({
  totalAnalyses: z.number().int().nonnegative(),
  activeDecisions: z.number().int().nonnegative(),
  highRiskFindings: z.number().int().nonnegative(),
  findingsWithoutTest: z.number().int().nonnegative(),
  unknownReasonFindings: z.number().int().nonnegative(),
});
export type DashboardSummary = z.infer<typeof DashboardSummarySchema>;

/**
 * Live integration status for the dashboard's settings screen.
 *
 * Every field is derived from state the API actually has — credentials present, the
 * explanation mode in use, whether a GitHub-sourced analysis has ever arrived — rather
 * than inferred or assumed. "Configured" and "has ever worked" are reported separately
 * on purpose: credentials being present does not prove a webhook was ever delivered,
 * and conflating the two is how a broken tunnel looks healthy.
 */
export const IntegrationsStatusSchema = z.object({
  github: z.object({
    /** GitHub App credentials (app id, private key, webhook secret) are loaded. */
    credentialsConfigured: z.boolean(),
    /** Timestamp of the most recent analysis that arrived from a GitHub webhook. */
    lastWebhookAnalysisAt: z.string().nullable(),
  }),
  explanations: z.object({
    /** `bedrock` only when explicitly enabled and fully configured; else the fallback. */
    source: z.enum(["bedrock", "fallback"]),
  }),
  readApi: z.object({
    /**
     * How the read API is reachable: `public-allow-list` when WHYGUARD_PUBLIC_REPOS
     * names repositories anyone may read, `token` when WHYGUARD_API_TOKEN is set, and
     * `loopback-only` when neither is — the default, which serves no remote caller.
     */
    access: z.enum(["token", "loopback-only", "public-allow-list"]),
  }),
});
export type IntegrationsStatus = z.infer<typeof IntegrationsStatusSchema>;

export const AnalysisRunSummarySchema = z.object({
  id: z.string().min(1),
  repositoryName: z.string().min(1),
  baseSha: z.string().min(1),
  headSha: z.string().min(1),
  source: z.string().min(1),
  status: z.string().min(1),
  createdAt: z.string().min(1),
  llmEnabled: z.boolean(),
  pullRequestNumber: z.number().int().nullable(),
  checkRunUrl: z.string().nullable(),
  findingCount: z.number().int().nonnegative(),
  highestSeverity: SeveritySchema.nullable(),
});
export type AnalysisRunSummary = z.infer<typeof AnalysisRunSummarySchema>;

export const AnalysisRunFindingSchema = z.object({
  id: z.string().min(1),
  runId: z.string().min(1),
  change: SensitiveChangeSchema,
  severity: SeveritySchema,
  riskScore: z.number(),
  confidenceScore: z.number(),
  reasonStatus: ReasonStatusSchema,
  explanation: z.string().min(1),
  recommendation: z.string().min(1),
  matchingDecisionId: z.string().nullable(),
  regressionTestStatus: z.string().min(1),
  evidence: z.array(EvidenceSchema),
  protectedProperties: z.array(ProtectedPropertySchema),
});
export type AnalysisRunFindingDto = z.infer<typeof AnalysisRunFindingSchema>;

/**
 * LLM-produced explanation contract. The LLM is a synthesis layer, not the source of
 * truth — this schema is the enforcement point for
 * that rule: `usedEvidenceIds` must reference evidence the caller actually
 * gathered, and any output that fails this schema (missing fields, or citing
 * unknown evidence — checked separately by `llm-adapter`) is rejected in favor
 * of the deterministic fallback.
 */
export const LlmExplanationSchema = z.object({
  summary: z.string().min(1),
  protectedProperty: z.string().min(1),
  recommendation: z.string().min(1),
  usedEvidenceIds: z.array(z.string().min(1)).min(1),
  uncertainty: z.string(),
  proposedTest: z.string().optional(),
  /**
   * Which path produced this explanation. `"fallback"` means Bedrock was unavailable,
   * disabled, or its output failed validation, and the deterministic template was used
   * instead — the tool keeps working either way. Never hidden from the caller: the
   * dashboard and the CLI both surface this, so a fallback explanation is never mistaken
   * for a model-grounded one.
   */
  source: z.enum(["bedrock", "fallback"]),
  generatedAt: z.string().min(1),
});
export type LlmExplanation = z.infer<typeof LlmExplanationSchema>;

/** Validates and returns an LlmExplanation, or throws a ZodError with details. */
export function parseLlmExplanation(input: unknown): LlmExplanation {
  return LlmExplanationSchema.parse(input);
}

export const DecisionDetailSchema = z.object({
  id: z.string().min(1),
  version: z.number().int().positive(),
  status: z.enum(["draft", "active", "replaced", "expired"]),
  reason: z.string().min(1),
  owners: z.array(z.string().min(1)),
  scope: z.object({
    files: z.array(z.string().min(1)),
    symbols: z.array(z.string().min(1)).optional(),
  }),
  mustPreserve: z.array(z.string().min(1)),
  evidence: z.array(RationaleContractEvidenceRefSchema),
  requiredTests: z.array(z.string().min(1)),
  sourcePath: z.string().nullable(),
  updatedAt: z.string().min(1),
  linkedFindings: z.array(AnalysisRunFindingSchema),
});
export type DecisionDetail = z.infer<typeof DecisionDetailSchema>;

/**
 * `AnalysisRunFindingDto` extended with its persisted LLM explanation, if any
 * was computed. Kept as a separate extension (rather than adding the field
 * directly to `AnalysisRunFindingSchema`) so callers that don't need the
 * explanation (e.g. `DecisionDetail.linkedFindings`) aren't forced to carry it.
 */
export const AnalysisRunFindingWithExplanationSchema = AnalysisRunFindingSchema.extend({
  llmExplanation: LlmExplanationSchema.nullable(),
});
export type AnalysisRunFindingWithExplanation = z.infer<
  typeof AnalysisRunFindingWithExplanationSchema
>;

export const AnalysisRunDetailSchema = AnalysisRunSummarySchema.extend({
  findings: z.array(AnalysisRunFindingWithExplanationSchema),
});
export type AnalysisRunDetail = z.infer<typeof AnalysisRunDetailSchema>;
