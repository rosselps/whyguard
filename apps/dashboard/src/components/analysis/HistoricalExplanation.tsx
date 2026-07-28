import { Sparkles } from "lucide-react";
import type { LlmExplanation } from "@whyguard/contracts";
import { Badge } from "../ui/Badge.js";

export type HistoricalExplanationProps = {
  explanation: LlmExplanation;
};

/**
 * Renders the LLM synthesis step.
 * Always placed after evidence in the page, never before. The `source` badge is never hidden — a fallback explanation
 * must never be presented as if a model reviewed it (per the schema's own
 * comment in `@whyguard/contracts`).
 */
export function HistoricalExplanation({ explanation }: HistoricalExplanationProps) {
  return (
    <div className="rounded-wg-card border border-wg-border bg-wg-surface-2 p-4">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="flex items-center gap-2 text-sm font-bold text-wg-text">
          <Sparkles className="h-4 w-4 text-wg-accent" aria-hidden="true" />
          Síntesis
        </h3>
        <Badge variant={explanation.source === "bedrock" ? "info" : "neutral"}>
          {explanation.source === "bedrock" ? "Generado por modelo" : "Plantilla determinística"}
        </Badge>
      </div>
      <p className="text-sm text-wg-text-2">{explanation.summary}</p>
      <p className="mt-2 text-xs text-wg-muted">{explanation.uncertainty}</p>
    </div>
  );
}
