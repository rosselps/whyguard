import type { RationaleContractEvidenceRef } from "@whyguard/contracts";
import { GitCommit, Link as LinkIcon } from "lucide-react";

export type EvidenceRefListProps = {
  evidence: RationaleContractEvidenceRef[];
};

/**
 * Renders a decision's raw evidence references (`type` + `id` only — a
 * rationale contract doesn't carry a title/strength the way a computed Finding
 * does). Kept separate from `EvidenceTimeline`, which renders the richer
 * `Evidence` shape — the two are intentionally not the same DTO
 * (`@whyguard/contracts`'s `RationaleContractEvidenceRef` vs `Evidence`).
 */
export function EvidenceRefList({ evidence }: EvidenceRefListProps) {
  if (evidence.length === 0) {
    return <p className="text-sm text-wg-muted">No hay evidencia registrada.</p>;
  }

  return (
    <ol className="flex flex-col gap-2">
      {evidence.map((item, index) => (
        <li
          key={`${item.type}-${item.id}-${index}`}
          className="flex items-center gap-2 text-sm text-wg-text-2"
        >
          {item.type === "commit" ? (
            <GitCommit className="h-4 w-4 text-wg-info" aria-hidden="true" />
          ) : (
            <LinkIcon className="h-4 w-4 text-wg-info" aria-hidden="true" />
          )}
          <span className="capitalize">{item.type.replace("_", " ")}</span>
          <span className="font-mono text-xs text-wg-muted">#{item.id}</span>
        </li>
      ))}
    </ol>
  );
}
