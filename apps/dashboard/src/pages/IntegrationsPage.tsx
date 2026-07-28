import { Cable, Github, Lock, Sparkles } from "lucide-react";
import type { ReactNode } from "react";
import { PageHeader } from "../components/layout/PageHeader.js";
import { Panel } from "../components/ui/Panel.js";
import { Badge, type BadgeVariant } from "../components/ui/Badge.js";
import { Skeleton } from "../components/ui/Skeleton.js";
import { ErrorState } from "../components/ui/ErrorState.js";
import type { IntegrationsStatus } from "@whyguard/contracts";
import { useIntegrationsQuery } from "../lib/queries.js";
import { formatTimestamp } from "../lib/format.js";

/**
 * Copy for every value of `readApi.access`, as an exhaustive `Record`.
 *
 * A `Record` keyed on the union rather than a ternary on `=== "token"`: that ternary
 * collapsed the two non-token modes into one, so a deployment serving the public
 * allow-list reported "Solo local" and told the reader to set `WHYGUARD_API_TOKEN` —
 * advice that would have taken the public dashboard offline. Adding a fourth access mode
 * now fails to compile instead of quietly picking the wrong branch.
 */
const READ_ACCESS_COPY: Record<
  IntegrationsStatus["readApi"]["access"],
  { badge: { variant: BadgeVariant; text: string }; detail: string }
> = {
  token: {
    badge: { variant: "success", text: "Requiere token" },
    detail: "La API exige un token. Necesario antes de exponerla en una URL pública.",
  },
  "public-allow-list": {
    badge: { variant: "info", text: "Lectura pública" },
    detail:
      "Cualquiera puede leer los análisis de los repositorios nombrados en WHYGUARD_PUBLIC_REPOS, y solo esos: el resto responde 404, no 403, para no confirmar qué existe. Escribir sigue exigiendo la firma del webhook de GitHub.",
  },
  "loopback-only": {
    badge: { variant: "warning", text: "Solo local" },
    detail:
      "La API solo responde a peticiones locales. Si la despliegas en una URL pública, define WHYGUARD_API_TOKEN: sin él, toda petición remota se rechaza.",
  },
};

/**
 * GitHub + Kiro + explanation status, read from `GET /integrations`.
 *
 * Previously this page hardcoded "Estado no disponible" for everything, which told a
 * reader nothing and looked broken. Every row now reflects state the API actually knows.
 *
 * The GitHub row deliberately reports two separate facts: credentials are configured,
 * and a webhook analysis has actually arrived. Treating the first as proof of the second
 * is how a wrong webhook URL or a dead tunnel looks perfectly healthy — which happened
 * during real testing.
 */
export function IntegrationsPage() {
  const query = useIntegrationsQuery();

  return (
    <>
      <PageHeader
        eyebrow="Configuración"
        title="Integraciones"
        description="De dónde recibe WhyGuard los análisis y cómo está protegido este panel."
      />

      {query.isPending ? (
        <div className="flex flex-col gap-3">
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
        </div>
      ) : query.isError ? (
        <ErrorState message="No se pudo cargar el estado de las integraciones." />
      ) : (
        <div className="flex flex-col gap-3">
          <StatusRow
            icon={<Github className="h-5 w-5 text-wg-muted" aria-hidden="true" />}
            title="GitHub App"
            subtitle="Recibe Pull Requests y publica el Check con el resultado."
            badge={
              query.data.github.credentialsConfigured
                ? { variant: "success", text: "Credenciales cargadas" }
                : { variant: "danger", text: "Sin credenciales" }
            }
            detail={
              query.data.github.lastWebhookAnalysisAt
                ? `Último análisis recibido por webhook: ${formatTimestamp(
                    query.data.github.lastWebhookAnalysisAt,
                  )}.`
                : "Todavía no ha llegado ningún análisis por webhook. Tener credenciales no prueba que la entrega funcione: revisa la URL del webhook y el túnel si esperabas alguno."
            }
          />

          <StatusRow
            icon={<Sparkles className="h-5 w-5 text-wg-muted" aria-hidden="true" />}
            title="Explicaciones"
            subtitle="Cómo se redacta el resumen de cada hallazgo."
            badge={
              query.data.explanations.source === "bedrock"
                ? { variant: "brand", text: "Amazon Bedrock" }
                : { variant: "neutral", text: "Plantilla determinística" }
            }
            detail={
              query.data.explanations.source === "bedrock"
                ? "Un modelo redacta el resumen sobre evidencia ya reunida. Nunca decide si bloquear, y su salida se valida contra un esquema."
                : "Sin llamadas a ningún modelo. El riesgo y la evidencia se calculan igual: el modelo solo redactaría el resumen."
            }
          />

          <StatusRow
            icon={<Lock className="h-5 w-5 text-wg-muted" aria-hidden="true" />}
            title="Acceso a este panel"
            subtitle="Quién puede leer los análisis a través de la API."
            badge={READ_ACCESS_COPY[query.data.readApi.access].badge}
            detail={READ_ACCESS_COPY[query.data.readApi.access].detail}
          />

          <Panel className="bg-wg-surface-2">
            <p className="flex items-center gap-2 text-sm font-semibold text-wg-text">
              <Cable className="h-4 w-4 text-wg-muted" aria-hidden="true" />
              Kiro (hook + MCP)
            </p>
            <p className="mt-1 text-xs leading-relaxed text-wg-muted">
              Se configura por repositorio, no aquí:{" "}
              <span className="font-mono">whyguard init</span> escribe el hook y el servidor MCP en
              el proyecto que quieras proteger. Este panel no puede saber si un editor está
              corriendo, así que no lo inventa.
            </p>
          </Panel>
        </div>
      )}
    </>
  );
}

function StatusRow({
  icon,
  title,
  subtitle,
  badge,
  detail,
}: {
  icon: ReactNode;
  title: string;
  subtitle: string;
  badge: { variant: BadgeVariant; text: string };
  detail: string;
}) {
  return (
    <Panel>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          {icon}
          <div>
            <p className="text-sm font-semibold text-wg-text">{title}</p>
            <p className="text-xs text-wg-muted">{subtitle}</p>
          </div>
        </div>
        <Badge variant={badge.variant}>{badge.text}</Badge>
      </div>
      <p className="mt-3 text-xs leading-relaxed text-wg-muted">{detail}</p>
    </Panel>
  );
}
