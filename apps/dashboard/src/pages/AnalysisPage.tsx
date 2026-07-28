import { useParams } from "react-router-dom";
import { PageHeader } from "../components/layout/PageHeader.js";
import { Panel } from "../components/ui/Panel.js";
import { Skeleton } from "../components/ui/Skeleton.js";
import { EmptyState } from "../components/ui/EmptyState.js";
import { ErrorState } from "../components/ui/ErrorState.js";
import { HistoricalRiskAlert } from "../components/risk/HistoricalRiskAlert.js";
import { DecisionCard } from "../components/decisions/DecisionCard.js";
import { EvidenceTimeline } from "../components/evidence/EvidenceTimeline.js";
import { HistoricalExplanation } from "../components/analysis/HistoricalExplanation.js";
import { RegressionTestPanel } from "../components/analysis/RegressionTestPanel.js";
import { ActionBar } from "../components/analysis/ActionBar.js";
import { useReportQuery, useRegressionTestProposalMutation } from "../lib/queries.js";
import { formatRepositoryName, formatTimestamp } from "../lib/format.js";

/**
 * Pull Request analysis — the core review surface.
 * Mandatory hierarchy: risk + decision
 * first, then evidence, then the LLM synthesis (`HistoricalExplanation`),
 * then action. The explanation always renders after `EvidenceTimeline`, never
 * before —: "no colocar la salida del LLM antes de la
 * evidencia."
 */
export function AnalysisPage() {
  const { analysisId } = useParams<{ analysisId: string }>();
  const reportQuery = useReportQuery(analysisId);

  if (reportQuery.isPending) {
    return (
      <div className="flex flex-col gap-3">
        <Skeleton className="h-8 w-1/3" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }

  if (reportQuery.isError) {
    return <ErrorState message="No se pudo cargar este análisis." />;
  }

  const report = reportQuery.data;

  return (
    <>
      <PageHeader
        // Not every analysis is a Pull Request: a local `whyguard scan` produces one
        // too, and labelling those "Análisis de Pull Request" was simply wrong.
        eyebrow={report.source === "github" ? "Análisis de Pull Request" : "Análisis local (CLI)"}
        title={formatRepositoryName(report.repositoryName)}
        description={`${report.source} · ${formatTimestamp(report.createdAt)}${
          report.pullRequestNumber ? ` · PR #${report.pullRequestNumber}` : ""
        }`}
        action={
          report.checkRunUrl ? (
            <a
              href={report.checkRunUrl}
              target="_blank"
              rel="noreferrer"
              className="text-sm font-semibold text-wg-brand-400 hover:underline"
            >
              Ver Check en GitHub
            </a>
          ) : null
        }
      />

      {report.findings.length === 0 ? (
        <EmptyState
          title="Sin riesgos detectados"
          description="No se encontraron decisiones protegidas afectadas por este cambio."
        />
      ) : (
        <div className="flex flex-col gap-4">
          {report.findings.map((finding) => (
            <FindingPanel key={finding.id} finding={finding} />
          ))}
        </div>
      )}
    </>
  );
}

type ReportFinding = ReturnType<typeof useReportQuery>["data"] extends
  { findings: (infer Finding)[] } | undefined
  ? Finding
  : never;

/**
 * One finding's full review card. Split out from `AnalysisPage` so the
 * "Generar prueba" mutation state (per-finding, since a page can have several
 * findings) has its own hook instance instead of one shared across all of them.
 */
function FindingPanel({ finding }: { finding: ReportFinding }) {
  const regressionTestMutation = useRegressionTestProposalMutation();

  return (
    <Panel className="flex flex-col gap-4">
      <HistoricalRiskAlert finding={finding} />
      <DecisionCard finding={finding} />
      <div>
        <h3 className="mb-2 text-sm font-bold text-wg-text">Evidencia</h3>
        <EvidenceTimeline evidence={finding.evidence} />
      </div>
      {finding.llmExplanation ? (
        <HistoricalExplanation explanation={finding.llmExplanation} />
      ) : null}
      {regressionTestMutation.data ? (
        <RegressionTestPanel proposal={regressionTestMutation.data} />
      ) : null}
      {regressionTestMutation.isError ? (
        <ErrorState message="No se pudo generar la prueba sugerida." />
      ) : null}
      <ActionBar
        decisionId={finding.matchingDecisionId}
        onGenerateTest={() => regressionTestMutation.mutate({ findingId: finding.id })}
        isGeneratingTest={regressionTestMutation.isPending}
      />
    </Panel>
  );
}
