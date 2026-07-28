/**
 * Module criticality heuristic. The document does not fix an exact scoring table, so this
 * is a deterministic, explainable path-based heuristic used as the `moduleCriticality`
 * risk factor input.
 */
const HIGH_CRITICALITY_PATTERNS = [/payments?/i, /billing/i, /auth/i, /orders?/i];
const MEDIUM_CRITICALITY_PATTERNS = [/logistics/i, /schedul/i, /timezone/i, /date/i, /rounding/i];

export function estimateModuleCriticality(filePath: string): number {
  const normalized = filePath.replace(/\\/g, "/");
  if (HIGH_CRITICALITY_PATTERNS.some((pattern) => pattern.test(normalized))) return 90;
  if (MEDIUM_CRITICALITY_PATTERNS.some((pattern) => pattern.test(normalized))) return 60;
  return 30;
}
