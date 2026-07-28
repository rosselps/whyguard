import { TriangleAlert, CircleCheck, Circle } from "lucide-react";
import { Badge } from "../ui/Badge.js";
import { RISK_BADGE_VARIANT, RISK_LABEL, type RiskLevel } from "../../lib/risk.js";

const ICON: Record<RiskLevel, typeof TriangleAlert> = {
  high: TriangleAlert,
  medium: TriangleAlert,
  low: CircleCheck,
  none: Circle,
};

export type RiskBadgeProps = {
  level: RiskLevel;
};

/**
 * Risk badge: icon + text + color, always. Never renders with only a color swatch.
 */
export function RiskBadge({ level }: RiskBadgeProps) {
  const Icon = ICON[level];
  return (
    <Badge variant={RISK_BADGE_VARIANT[level]}>
      <Icon className="h-3 w-3" aria-hidden="true" />
      {RISK_LABEL[level]}
    </Badge>
  );
}
