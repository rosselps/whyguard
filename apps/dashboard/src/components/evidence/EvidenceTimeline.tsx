import type { Evidence } from "@whyguard/contracts";
import { GitCommit, Link as LinkIcon } from "lucide-react";
import { Badge } from "../ui/Badge.js";
import { evidenceStrengthLabel, evidenceStrengthVariant } from "../../lib/evidence.js";

export type EvidenceTimelineProps = {
  evidence: Evidence[];
};

/**
 * Evidence precedes explanation. Rendered as a
 * semantically ordered list's accessibility rule:
 * "El timeline de evidencia debe tener una representación semántica como lista
 * ordenada."
 */
export function EvidenceTimeline({ evidence }: EvidenceTimelineProps) {
  if (evidence.length === 0) {
    return <p className="text-sm text-wg-muted">No hay evidencia registrada.</p>;
  }

  return (
    <ol className="flex flex-col gap-3">
      {evidence.map((item) => (
        <li key={item.id} className="flex gap-3 border-l-2 border-wg-border pl-3">
          <span className="mt-0.5 text-wg-info" aria-hidden="true">
            {item.type === "commit" ? (
              <GitCommit className="h-4 w-4" />
            ) : (
              <LinkIcon className="h-4 w-4" />
            )}
          </span>
          <div className="flex-1">
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold text-wg-text">{item.title}</span>
              <Badge variant={evidenceStrengthVariant(item.strength)}>
                {evidenceStrengthLabel(item.strength)}
              </Badge>
            </div>
            <p className="mt-0.5 text-xs text-wg-muted">
              {item.type} · {item.id}
            </p>
          </div>
        </li>
      ))}
    </ol>
  );
}
