import { Link } from "react-router-dom";
import { FileBadge } from "lucide-react";
import type { AnalysisRunFindingDto } from "@whyguard/contracts";
import { RiskBadge } from "../risk/RiskBadge.js";
import { severityToRiskLevel } from "../../lib/risk.js";
import { Panel } from "../ui/Panel.js";

export type DecisionCardProps = {
  finding: AnalysisRunFindingDto;
};

/**
 * Summarizes the historical decision a finding is affecting: "DecisionCard: ID, nombre, propósito, riesgo, cobertura y estado de
 * prueba." Links to the decision detail page when a decision id is known;
 * otherwise the finding is `unknown`-reason and there is no decision to link to
 * (never invent a decision that wasn't
 * confirmed).
 */
export function DecisionCard({ finding }: DecisionCardProps) {
  const risk = severityToRiskLevel(finding.severity);
  const content = (
    <Panel className="flex items-center justify-between gap-4 transition-colors hover:border-wg-brand-400">
      <div className="flex items-center gap-3">
        <FileBadge className="h-5 w-5 text-wg-brand-400" aria-hidden="true" />
        <div>
          <p className="text-sm font-semibold text-wg-text">
            {finding.matchingDecisionId ?? "Sin decisión confirmada"}
          </p>
          <p className="text-xs text-wg-muted">
            {finding.change.filePath}
            {finding.change.symbol ? ` :: ${finding.change.symbol}` : ""}
          </p>
        </div>
      </div>
      <RiskBadge level={risk} />
    </Panel>
  );

  if (!finding.matchingDecisionId) {
    return content;
  }

  return (
    <Link
      to={`/decisions/${encodeURIComponent(finding.matchingDecisionId)}`}
      className="block rounded-wg-card focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-wg-brand-400"
    >
      {content}
    </Link>
  );
}
