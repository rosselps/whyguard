import { useParams } from "react-router-dom";
import { PageHeader } from "../components/layout/PageHeader.js";
import { Panel } from "../components/ui/Panel.js";
import { Skeleton } from "../components/ui/Skeleton.js";
import { ErrorState } from "../components/ui/ErrorState.js";
import { Badge } from "../components/ui/Badge.js";
import { EvidenceRefList } from "../components/evidence/EvidenceRefList.js";
import { ProtectedProperty } from "../components/decisions/ProtectedProperty.js";
import { useDecisionQuery } from "../lib/queries.js";
import { formatTimestamp } from "../lib/format.js";

const STATUS_VARIANT: Record<string, "success" | "neutral" | "warning" | "danger"> = {
  active: "success",
  candidate: "neutral",
  draft: "neutral",
  superseded: "warning",
  replaced: "warning",
  expired: "danger",
};

/**
 * Decision detail — memoria institucional. Separates
 * Razón / Comportamiento a preservar / Linaje de evidencia / Prueba / Estado
 * into distinct sections, each answering exactly one of the questions in
 * spec table. Per the same section's callout box: this page must
 * never imply a decision protects a line of code — only the behavior.
 */
export function DecisionPage() {
  const { decisionId } = useParams<{ decisionId: string }>();
  const decisionQuery = useDecisionQuery(decisionId);

  if (decisionQuery.isPending) {
    return (
      <div className="flex flex-col gap-3">
        <Skeleton className="h-8 w-1/3" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  if (decisionQuery.isError) {
    return <ErrorState message="No se pudo cargar esta decisión." />;
  }

  const decision = decisionQuery.data;
  const statusVariant = STATUS_VARIANT[decision.status] ?? "neutral";

  return (
    <>
      <PageHeader
        eyebrow="Detalle de decisión"
        title={decision.id}
        description={`Versión ${decision.version} · Actualizada ${formatTimestamp(decision.updatedAt)}`}
        action={<Badge variant={statusVariant}>{decision.status.toUpperCase()}</Badge>}
      />

      <div className="grid gap-4 md:grid-cols-2">
        <Panel>
          <h2 className="mb-2 text-sm font-bold text-wg-text">¿Por qué existe esta decisión?</h2>
          <p className="text-sm text-wg-text-2">{decision.reason}</p>
        </Panel>

        <Panel>
          <h2 className="mb-2 text-sm font-bold text-wg-text">Comportamiento a preservar</h2>
          <ul className="flex flex-col gap-2">
            {decision.mustPreserve.map((statement, index) => (
              <ProtectedProperty
                key={index}
                property={{
                  id: `${decision.id}-${index}`,
                  statement,
                  category: "business_rule",
                  status: "confirmed",
                }}
              />
            ))}
          </ul>
        </Panel>

        <Panel>
          <h2 className="mb-2 text-sm font-bold text-wg-text">Linaje de evidencia</h2>
          <EvidenceRefList evidence={decision.evidence} />
        </Panel>

        <Panel>
          <h2 className="mb-2 text-sm font-bold text-wg-text">Pruebas de regresión vinculadas</h2>
          {decision.linkedFindings.length === 0 ? (
            <p className="text-sm text-wg-muted">
              Ningún análisis reciente encontró un cambio afectando esta decisión.
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {decision.linkedFindings.map((finding) => (
                <li key={finding.id} className="text-sm text-wg-text-2">
                  {finding.change.filePath} — {finding.regressionTestStatus}
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      {decision.owners.length > 0 ? (
        <p className="mt-4 text-xs text-wg-muted">Responsables: {decision.owners.join(", ")}</p>
      ) : null}
    </>
  );
}
