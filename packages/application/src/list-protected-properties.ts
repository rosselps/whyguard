import type { ProtectedProperty } from "@whyguard/contracts";
import { loadActiveContracts } from "./evidence-gathering.js";
import { contractToProtectedProperties } from "./finding-builder.js";
import { listFindings } from "./finding-store.js";
import { findMatchingContract, normalizePath } from "./rationale-contracts.js";

/**
 * `whyguard.list_protected_properties` use case's MCP tool table: "path/symbol -> ProtectedProperty[]".
 *
 * Two deterministic sources are combined, de-duplicated by `id`:
 * 1. Any confirmed rationale contract in `.whyguard/decisions/` whose scope covers
 *    the file/symbol (already-confirmed properties).
 * 2. Any Finding recorded in this process (via `scanDiff`/`guardChange`) whose
 *    change touches the same file/symbol — these may be `proposed` rather than
 *    `confirmed`, since a scan alone never confirms a property.
 *
 * Read-only, no LLM, no network.
 */
export type ListProtectedPropertiesInput = {
  repoRoot: string;
  filePath: string;
  symbol?: string;
};

export function listProtectedProperties(input: ListProtectedPropertiesInput): ProtectedProperty[] {
  const { repoRoot, filePath, symbol } = input;

  const activeContracts = loadActiveContracts(repoRoot);
  const matchingContract = findMatchingContract(activeContracts, filePath, symbol);
  const fromContract = matchingContract ? contractToProtectedProperties(matchingContract) : [];

  const normalizedTarget = normalizePath(filePath);
  const fromFindings = listFindings()
    .filter((finding) => {
      const sameFile = normalizePath(finding.change.filePath) === normalizedTarget;
      if (!sameFile) return false;
      if (!symbol) return true;
      return finding.change.symbol === undefined || finding.change.symbol === symbol;
    })
    .flatMap((finding) => finding.protectedProperties);

  const byId = new Map<string, ProtectedProperty>();
  for (const property of [...fromContract, ...fromFindings]) {
    if (!byId.has(property.id)) byId.set(property.id, property);
  }
  return [...byId.values()];
}
