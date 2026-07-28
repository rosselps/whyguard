import { Link } from "react-router-dom";
import { CircleHelp, FileSearch, FlaskConical, ScrollText, ShieldAlert } from "lucide-react";
import { PageHeader } from "../components/layout/PageHeader.js";
import { Panel } from "../components/ui/Panel.js";
import { Skeleton } from "../components/ui/Skeleton.js";
import { EmptyState } from "../components/ui/EmptyState.js";
import { ErrorState } from "../components/ui/ErrorState.js";
import { RiskBadge } from "../components/risk/RiskBadge.js";
import { MetricCard } from "../components/overview/MetricCard.js";
import { WhatIsWhyGuard } from "../components/overview/WhatIsWhyGuard.js";
import { useReportsQuery, useSummaryQuery } from "../lib/queries.js";
import { severityToRiskLevel } from "../lib/risk.js";
import { formatRepositoryName, formatTimestamp } from "../lib/format.js";

/**
 * Repository overview (, screen 1).
 *
 * Three bands, in the order a first-time reader needs them: what WhyGuard is, the
 * aggregate numbers, then the log of individual analyses. The previous version had only
 * the third band, which left the page unreadable without prior context.
 *
 * Per state table: skeletons keep layout stable, the empty state is a
 * next-step instruction rather than an alarming graphic, and an error is scoped to the
 * block that failed so one broken query does not blank the page.
 */
export function DashboardPage() {
  const reportsQuery = useReportsQuery();
  const summaryQuery = useSummaryQuery();

  return (
    <>
      <PageHeader
        eyebrow="Resumen"
        title="Dashboard"
        description="Qué decisiones históricas está protegiendo WhyGuard y qué análisis se han hecho."
      />

      <WhatIsWhyGuard />

      <section aria-labelledby="metrics-heading" className="mb-6">
        <h2 id="metrics-heading" className="mb-3 text-lg font-bold text-wg-text">
          Estado general
        </h2>

        {summaryQuery.isPending ? (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <Skeleton className="h-28 w-full" />
            <Skeleton className="h-28 w-full" />
            <Skeleton className="h-28 w-full" />
            <Skeleton className="h-28 w-full" />
          </div>
        ) : summaryQuery.isError ? (
          <ErrorState message="No se pudo cargar el estado general." />
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <MetricCard
              label="Decisiones protegidas"
              value={summaryQuery.data.activeDecisions}
              hint="Contratos .whyguard/decisions confirmados por una persona. Son la señal más fuerte: convierten un aviso en un bloqueo."
              icon={<ScrollText className="h-4 w-4" />}
              tone="success"
            />
            <MetricCard
              label="Hallazgos de alto riesgo"
              value={summaryQuery.data.highRiskFindings}
              hint="Cambios que podrían haber eliminado un comportamiento protegido. Requieren que alguien los mire."
              icon={<ShieldAlert className="h-4 w-4" />}
              tone={summaryQuery.data.highRiskFindings > 0 ? "danger" : "neutral"}
            />
            <MetricCard
              label="Sin prueba de regresión"
              value={summaryQuery.data.findingsWithoutTest}
              hint="Nada demuestra hoy que ese comportamiento siga funcionando. Es lo que WhyGuard te ayuda a escribir."
              icon={<FlaskConical className="h-4 w-4" />}
              tone={summaryQuery.data.findingsWithoutTest > 0 ? "warning" : "neutral"}
            />
            <MetricCard
              label="Razón desconocida"
              value={summaryQuery.data.unknownReasonFindings}
              hint="WhyGuard detectó el cambio pero no encontró evidencia histórica. Lo dice en vez de inventar un motivo."
              icon={<CircleHelp className="h-4 w-4" />}
            />
          </div>
        )}
      </section>

      <section aria-labelledby="recent-analyses-heading">
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="recent-analyses-heading" className="text-lg font-bold text-wg-text">
            Análisis recientes
          </h2>
          {summaryQuery.data ? (
            <p className="text-xs text-wg-muted">
              {summaryQuery.data.totalAnalyses}{" "}
              {summaryQuery.data.totalAnalyses === 1 ? "análisis" : "análisis"} en total
            </p>
          ) : null}
        </div>

        <p className="mb-3 text-xs leading-relaxed text-wg-muted">
          Cada fila es una comparación entre dos versiones del código: un Pull Request (origen{" "}
          <span className="font-semibold">github</span>) o una ejecución local de{" "}
          <span className="font-mono">whyguard scan</span> (origen{" "}
          <span className="font-semibold">cli</span>). La etiqueta de la derecha es la severidad del
          hallazgo más grave. Entra a una fila para ver qué comportamiento estaba en juego y con qué
          evidencia.
        </p>

        {reportsQuery.isPending ? (
          <div className="flex flex-col gap-2">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
          </div>
        ) : reportsQuery.isError ? (
          <ErrorState message="No se pudieron cargar los análisis recientes." />
        ) : reportsQuery.data.length === 0 ? (
          <EmptyState
            title="Aún no hay análisis"
            description="Protege un repositorio con `whyguard init`, o ejecuta `whyguard scan --base <ref> --head <ref>` para que aparezca aquí. Abrir un Pull Request en un repo con la GitHub App instalada también genera un análisis."
          />
        ) : (
          <div className="flex flex-col gap-2">
            {reportsQuery.data.map((run) => (
              <Link key={run.id} to={`/analyses/${encodeURIComponent(run.id)}`}>
                <Panel className="flex items-center justify-between gap-4 transition-colors hover:border-wg-brand-400">
                  <div className="min-w-0">
                    <p
                      className="truncate text-sm font-semibold text-wg-text"
                      title={run.repositoryName}
                    >
                      {formatRepositoryName(run.repositoryName)}
                      {run.pullRequestNumber ? ` · PR #${run.pullRequestNumber}` : ""}
                    </p>
                    <p className="text-xs text-wg-muted">
                      {run.source} · {formatTimestamp(run.createdAt)} · {run.findingCount}{" "}
                      {run.findingCount === 1 ? "hallazgo" : "hallazgos"}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {run.findingCount === 0 ? (
                      <span className="text-xs text-wg-muted">nada que revisar</span>
                    ) : null}
                    <RiskBadge
                      level={
                        run.highestSeverity ? severityToRiskLevel(run.highestSeverity) : "none"
                      }
                    />
                  </div>
                </Panel>
              </Link>
            ))}
          </div>
        )}
      </section>

      <section aria-labelledby="how-to-read-heading" className="mt-8">
        <h2 id="how-to-read-heading" className="mb-3 text-lg font-bold text-wg-text">
          Cómo leer un hallazgo
        </h2>
        <Panel>
          <dl className="grid gap-4 sm:grid-cols-2">
            <Term
              icon={<FileSearch className="h-4 w-4 text-wg-info" aria-hidden="true" />}
              term="Propiedad protegida"
              definition="El comportamiento que hay que preservar, escrito como algo observable: “una clave de idempotencia crea como máximo una orden”. No es “no borres estas líneas”."
            />
            <Term
              icon={<ScrollText className="h-4 w-4 text-wg-success" aria-hidden="true" />}
              term="Evidencia"
              definition="De dónde sale esa razón: un commit, un issue, un PR o un contrato de decisión. Cada ítem trae su fuerza (fuerte, media, débil)."
            />
            <Term
              icon={<ShieldAlert className="h-4 w-4 text-wg-warning" aria-hidden="true" />}
              term="Riesgo y confianza"
              definition="Dos números distintos y a propósito: riesgo es cuánto importaría equivocarse; confianza es cuán seguro está WhyGuard de la razón. Solo bloquea cuando ambos son altos."
            />
            <Term
              icon={<FlaskConical className="h-4 w-4 text-wg-info" aria-hidden="true" />}
              term="Generar prueba"
              definition="Redacta el esqueleto de un test que dejaría demostrado ese comportamiento, para que un refactor futuro no dependa de recordar por qué. Nunca se ejecuta solo: lo copias, completas la aserción y decides tú."
            />
          </dl>
        </Panel>
      </section>
    </>
  );
}

function Term({
  icon,
  term,
  definition,
}: {
  icon: React.ReactNode;
  term: string;
  definition: string;
}) {
  return (
    <div>
      <dt className="flex items-center gap-2 text-sm font-bold text-wg-text">
        {icon}
        {term}
      </dt>
      <dd className="mt-1 text-xs leading-relaxed text-wg-muted">{definition}</dd>
    </div>
  );
}
