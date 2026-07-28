import type { ReactNode } from "react";
import { Panel } from "../ui/Panel.js";

export type MetricCardProps = {
  label: string;
  value: number;
  /**
   * One short sentence saying what the number *means*, always rendered — not a
   * tooltip.
   *
   * A metric label alone ("Hallazgos sin prueba") assumes the reader already knows
   * WhyGuard's model. The whole point of this screen is that someone opening it for the
   * first time understands it without asking, so the explanation cannot be hidden
   * behind a hover — which is also unreachable on touch and by keyboard.
   */
  hint: string;
  icon: ReactNode;
  /** Colors the number only. Neutral by default: a count is not automatically alarming. */
  tone?: "neutral" | "danger" | "warning" | "success";
};

const TONE_CLASSES: Record<NonNullable<MetricCardProps["tone"]>, string> = {
  neutral: "text-wg-text",
  danger: "text-wg-danger",
  warning: "text-wg-warning",
  success: "text-wg-success",
};

/** Single overview KPI: icon, label, value and a plain-language explanation. */
export function MetricCard({ label, value, hint, icon, tone = "neutral" }: MetricCardProps) {
  return (
    <Panel className="flex flex-col gap-2">
      <div className="flex items-center gap-2 text-wg-muted">
        <span aria-hidden="true">{icon}</span>
        <span className="text-xs font-semibold uppercase tracking-wide">{label}</span>
      </div>
      <p className={`text-3xl font-bold leading-none ${TONE_CLASSES[tone]}`}>{value}</p>
      <p className="text-xs leading-relaxed text-wg-muted">{hint}</p>
    </Panel>
  );
}
