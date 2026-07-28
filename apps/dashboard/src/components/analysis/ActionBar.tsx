import { Link } from "react-router-dom";
import { Button } from "../ui/Button.js";

export type ActionBarProps = {
  decisionId: string | null;
  /** Called when "Generar prueba" is clicked. Omit to render it disabled. */
  onGenerateTest?: () => void;
  isGeneratingTest?: boolean;
};

/**
 * Ver decisión / Generar prueba / Continuar con justificación step 6. "Continuar con justificación" still has no write API to call —
 * it renders disabled with a clear reason rather than silently doing nothing,
 * which would leave a block with no way out. "Generar
 * prueba" is wired to `onGenerateTest` (Phase 5 addition, see
 * `RegressionTestPanel`).
 */
export function ActionBar({ decisionId, onGenerateTest, isGeneratingTest }: ActionBarProps) {
  return (
    <div className="border-t border-wg-border pt-4">
      <div className="flex flex-wrap gap-2">
        {decisionId ? (
          <Link to={`/decisions/${encodeURIComponent(decisionId)}`}>
            <Button variant="secondary">Ver decisión</Button>
          </Link>
        ) : null}
        <Button
          variant="primary"
          onClick={onGenerateTest}
          disabled={!onGenerateTest || isGeneratingTest}
          title={
            onGenerateTest
              ? undefined
              : "Disponible cuando el MCP de generación de pruebas esté conectado al dashboard."
          }
        >
          {isGeneratingTest ? "Generando…" : "Generar prueba de regresión"}
        </Button>
        <Button
          variant="danger"
          disabled
          title="Disponible cuando el flujo de justificación esté conectado al dashboard."
        >
          Continuar con justificación
        </Button>
      </div>

      {/*
        The label alone did not say what the button produces, and a reader could
        reasonably fear it runs code or edits the repository. Both actions are described
        inline instead: "Generar prueba" was genuinely ambiguous in review, and
        "Continuar con justificación" is disabled, which the UI spec requires
        ("no bloquear sin salida") must come with a stated reason rather than a dead
        control.
      */}
      <dl className="mt-3 space-y-1 text-xs leading-relaxed text-wg-muted">
        <div>
          <dt className="inline font-semibold text-wg-text-2">Generar prueba de regresión:</dt>{" "}
          <dd className="inline">
            redacta el esqueleto de un test que dejaría demostrada la propiedad protegida. Aparece
            aquí abajo para copiarlo — WhyGuard no lo escribe en tu repositorio ni lo ejecuta.
          </dd>
        </div>
        <div>
          <dt className="inline font-semibold text-wg-text-2">Continuar con justificación:</dt>{" "}
          <dd className="inline">
            registraría por qué este cambio es aceptable pese al hallazgo. Todavía no está
            conectado; por ahora eso se hace editando el contrato en{" "}
            <span className="font-mono">.whyguard/decisions/</span>.
          </dd>
        </div>
      </dl>
    </div>
  );
}
