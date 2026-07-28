import { useMutation } from "@tanstack/react-query";
import { useQuery } from "@tanstack/react-query";
import {
  fetchDecision,
  fetchReport,
  fetchReports,
  fetchIntegrations,
  fetchRegressionTestProposal,
  fetchSummary,
} from "./api.js";

/**
 * TanStack Query hooks wrapping the API client. Centralized here so every page
 * gets consistent loading/error semantics without repeating query keys.
 */
export function useReportsQuery() {
  return useQuery({ queryKey: ["reports"], queryFn: fetchReports });
}

export function useSummaryQuery() {
  return useQuery({ queryKey: ["summary"], queryFn: fetchSummary });
}

export function useIntegrationsQuery() {
  return useQuery({ queryKey: ["integrations"], queryFn: fetchIntegrations });
}

export function useReportQuery(id: string | undefined) {
  return useQuery({
    queryKey: ["reports", id],
    queryFn: () => fetchReport(id as string),
    enabled: Boolean(id),
  });
}

export function useDecisionQuery(id: string | undefined) {
  return useQuery({
    queryKey: ["decisions", id],
    queryFn: () => fetchDecision(id as string),
    enabled: Boolean(id),
  });
}

/**
 * A mutation, not a query: generating the regression-test proposal is an
 * explicit, user-triggered action (clicking "Generar prueba"), never fetched
 * automatically when the page loads — step 6, this is one
 * of the actions in the ActionBar, not passive page data.
 */
export function useRegressionTestProposalMutation() {
  return useMutation({
    mutationFn: (input: { findingId: string; framework?: string }) =>
      fetchRegressionTestProposal(input.findingId, input.framework),
  });
}
