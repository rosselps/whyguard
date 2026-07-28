import { TriangleAlert } from "lucide-react";
import type { AnalysisRunFindingDto } from "@whyguard/contracts";
import { Link } from "react-router-dom";

export type HistoricalRiskAlertProps = {
  finding: AnalysisRunFindingDto;
};

/**
 * Title + one-line explanation + risk level + action.
 * this always renders a link to
 * evidence/decision, never a dead-end. Uses `role="alert"` for high risk, without stealing focus (no autofocus here).
 */
export function HistoricalRiskAlert({ finding }: HistoricalRiskAlertProps) {
  const isHighRisk = finding.severity === "critical" || finding.severity === "high";
  return (
    <div
      role={isHighRisk ? "alert" : "status"}
      className="flex items-start gap-3 rounded-wg-card border border-wg-danger/40 bg-wg-danger/10 p-4"
    >
      <TriangleAlert className="mt-0.5 h-5 w-5 shrink-0 text-wg-danger" aria-hidden="true" />
      <div className="flex-1">
        <p className="text-sm font-semibold text-wg-text">
          Protección histórica potencialmente afectada
        </p>
        <p className="mt-1 text-sm text-wg-text-2">{finding.explanation}</p>
        {finding.matchingDecisionId ? (
          <Link
            to={`/decisions/${encodeURIComponent(finding.matchingDecisionId)}`}
            className="mt-2 inline-block text-sm font-semibold text-wg-brand-400 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-wg-brand-400"
          >
            Ver decisión
          </Link>
        ) : null}
      </div>
    </div>
  );
}
