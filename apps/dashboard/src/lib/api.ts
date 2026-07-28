import type {
  AnalysisRunDetail,
  AnalysisRunSummary,
  DashboardSummary,
  DecisionDetail,
  IntegrationsStatus,
  RegressionTestProposal,
} from "@whyguard/contracts";

/**
 * Thin fetch client for the read-only dashboard endpoints in
 * `apps/api/src/reports-routes.ts` (`GET /reports`, `GET /reports/:id`,
 * `GET /decisions/:id`). No write calls exist here — the dashboard never
 * triggers a scan or mutates data.
 *
 * Base URL comes from `VITE_WHYGUARD_API_URL`, defaulting to the same
 * `http://localhost:3000` the API listens on per `.env.example`'s `PORT=3000`.
 */
const API_BASE_URL: string = import.meta.env.VITE_WHYGUARD_API_URL ?? "http://localhost:3000";

/**
 * Optional bearer token for an API that requires one.
 *
 * Only useful for a deployment whose dashboard is as private as its data, because a
 * Vite variable is inlined into the bundle and therefore readable by anyone who loads
 * the page. For a genuinely public dashboard, leave this unset and name the readable
 * repositories with `WHYGUARD_PUBLIC_REPOS` on the API instead — that way what is
 * exposed is a deliberate list rather than a secret that is not secret.
 */
const API_TOKEN: string | undefined = import.meta.env.VITE_WHYGUARD_API_TOKEN;

function authHeaders(): HeadersInit | undefined {
  return API_TOKEN ? { Authorization: `Bearer ${API_TOKEN}` } : undefined;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, { headers: authHeaders() });
  if (response.status === 404) {
    throw new ApiError(404, `Not found: ${path}`);
  }
  if (!response.ok) {
    const body = await response.text();
    throw new ApiError(response.status, body || `Request to ${path} failed (${response.status}).`);
  }
  return (await response.json()) as T;
}

export function fetchReports(): Promise<AnalysisRunSummary[]> {
  return getJson<AnalysisRunSummary[]>("/reports");
}

/** Aggregate counts for the overview screen (`GET /summary`). */
export function fetchSummary(): Promise<DashboardSummary> {
  return getJson<DashboardSummary>("/summary");
}

/** Live integration status for the settings screen (`GET /integrations`). */
export function fetchIntegrations(): Promise<IntegrationsStatus> {
  return getJson<IntegrationsStatus>("/integrations");
}

export function fetchReport(id: string): Promise<AnalysisRunDetail> {
  return getJson<AnalysisRunDetail>(`/reports/${encodeURIComponent(id)}`);
}

export function fetchDecision(id: string): Promise<DecisionDetail> {
  return getJson<DecisionDetail>(`/decisions/${encodeURIComponent(id)}`);
}

/**
 * Fetches a deterministic regression-test skeleton for a finding (never an LLM
 * call — see `apps/api`'s `GET /findings/:id/regression-test`). This is only
 * ever triggered by an explicit user click on "Generar prueba"; the dashboard never prefetches or auto-generates this.
 */
export function fetchRegressionTestProposal(
  findingId: string,
  framework?: string,
): Promise<RegressionTestProposal> {
  const query = framework ? `?framework=${encodeURIComponent(framework)}` : "";
  return getJson<RegressionTestProposal>(
    `/findings/${encodeURIComponent(findingId)}/regression-test${query}`,
  );
}
