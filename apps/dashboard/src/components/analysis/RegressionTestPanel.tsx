import { useState } from "react";
import { Check, Copy, FlaskConical } from "lucide-react";
import type { RegressionTestProposal } from "@whyguard/contracts";
import { Badge } from "../ui/Badge.js";

export type RegressionTestPanelProps = {
  proposal: RegressionTestProposal;
};

/**
 * Displays a generated regression-test skeleton. Per rule 9 ("never auto-execute a generated test") and the UI/UX
 * spec's microcopy rule, this panel:
 * - never offers a "run" action, only "copy";
 * - labels the code as a skeleton/proposal, never as a passing test;
 * - uses monospace (JetBrains Mono) for the code block.
 */
export function RegressionTestPanel({ proposal }: RegressionTestPanelProps) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    await navigator.clipboard.writeText(proposal.code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="rounded-wg-card border border-wg-border bg-wg-surface-2 p-4">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-sm font-bold text-wg-text">
          <FlaskConical className="h-4 w-4 text-wg-info" aria-hidden="true" />
          Prueba de regresión sugerida
        </h3>
        <div className="flex items-center gap-2">
          <Badge variant="neutral">{proposal.framework}</Badge>
          <button
            type="button"
            onClick={() => void handleCopy()}
            className="flex items-center gap-1 rounded-wg-sm border border-wg-border px-2 py-1 text-xs font-semibold text-wg-text-2 hover:bg-wg-surface focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-wg-brand-400"
          >
            {copied ? (
              <>
                <Check className="h-3 w-3" aria-hidden="true" /> Copiado
              </>
            ) : (
              <>
                <Copy className="h-3 w-3" aria-hidden="true" /> Copiar
              </>
            )}
          </button>
        </div>
      </div>
      <p className="mb-2 text-xs text-wg-muted">
        Esqueleto sugerido para <span className="font-mono">{proposal.filePath}</span>. Un humano
        debe completar la aserción antes de usarlo; WhyGuard nunca lo ejecuta automáticamente.
      </p>
      <pre className="overflow-x-auto rounded-wg-md bg-wg-canvas p-3 font-mono text-xs text-wg-text-2">
        <code>{proposal.code}</code>
      </pre>
    </div>
  );
}
