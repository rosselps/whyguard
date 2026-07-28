import type { Severity } from "@whyguard/contracts";

/**
/**
 * Maps a domain `Severity` enum value to the label/colour/icon triple used everywhere risk
 * is shown, in one place: the frontend never infers a colour or a label from free text, it
 * receives a domain enum and maps it to a semantic component.
 */
export type RiskLevel = "high" | "medium" | "low" | "none";

const SEVERITY_TO_RISK: Record<Severity, RiskLevel> = {
  critical: "high",
  high: "high",
  medium: "medium",
  low: "low",
};

export function severityToRiskLevel(severity: Severity): RiskLevel {
  return SEVERITY_TO_RISK[severity];
}

export const RISK_LABEL: Record<RiskLevel, string> = {
  high: "ALTO",
  medium: "MEDIO",
  low: "BAJO",
  none: "SIN RIESGO",
};

export const RISK_BADGE_VARIANT: Record<RiskLevel, "danger" | "warning" | "success" | "neutral"> = {
  high: "danger",
  medium: "warning",
  low: "success",
  none: "neutral",
};
