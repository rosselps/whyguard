import { GitCommitHorizontal, ShieldCheck, TerminalSquare } from "lucide-react";
import { Panel } from "../ui/Panel.js";

/**
 * Explains what WhyGuard is and where it acts, on the first screen.
 *
 * Rationale: the dashboard is not the product — the guardrails are. Someone opening this
 * page cold sees a list of "analyses" with severity badges and has no way to infer *what
 * was protected from what*, or that the actual enforcement happens in Git and on Pull
 * Requests rather than here. Usability testing of the previous version produced exactly
 * that reaction ("viendo el UI no entiendo bien"), so the product's premise is stated
 * on the page instead of assumed.
 *
 * The three layers are deliberately described by *who enforces them*, not by name. The
 * difference between a gate Git enforces and a prompt an IDE merely shows is the single
 * most important thing for a reader to take away, and it is easy to get wrong.
 */
export function WhatIsWhyGuard() {
  return (
    <Panel className="mb-6 bg-wg-surface-2">
      <p className="text-sm leading-relaxed text-wg-text">
        Un repositorio recuerda <strong>qué</strong> cambió. WhyGuard reconstruye{" "}
        <strong>por qué</strong> cambió — el incidente, el issue o el PR detrás de una línea que hoy
        parece redundante — y avisa antes de que alguien la borre por accidente.
      </p>
      <p className="mt-2 text-xs leading-relaxed text-wg-muted">
        No protege código por ser antiguo: protege el <strong>comportamiento</strong> que ese código
        existía para preservar. Un refactor que mantiene ese comportamiento pasa sin problema.
      </p>

      <ul className="mt-4 grid gap-3 sm:grid-cols-3">
        <LayerItem
          icon={<GitCommitHorizontal className="h-4 w-4 text-wg-danger" aria-hidden="true" />}
          title="Al hacer commit"
          detail="Git aborta el commit. Es la única capa local que nadie puede ignorar."
        />
        <LayerItem
          icon={<ShieldCheck className="h-4 w-4 text-wg-warning" aria-hidden="true" />}
          title="En el Pull Request"
          detail="Publica un Check en GitHub, del lado del servidor."
        />
        <LayerItem
          icon={<TerminalSquare className="h-4 w-4 text-wg-info" aria-hidden="true" />}
          title="Mientras editas"
          detail="El IDE te pide confirmación antes de escribir. Es un aviso, no una barrera."
        />
      </ul>

      <p className="mt-4 text-xs text-wg-muted">
        Esta pantalla es solo el registro de lo analizado. La protección ocurre en las tres capas de
        arriba.
      </p>
    </Panel>
  );
}

function LayerItem({
  icon,
  title,
  detail,
}: {
  icon: React.ReactNode;
  title: string;
  detail: string;
}) {
  return (
    <li className="rounded-wg-md border border-wg-border bg-wg-surface p-3">
      <p className="flex items-center gap-2 text-xs font-bold text-wg-text">
        {icon}
        {title}
      </p>
      <p className="mt-1 text-xs leading-relaxed text-wg-muted">{detail}</p>
    </li>
  );
}
