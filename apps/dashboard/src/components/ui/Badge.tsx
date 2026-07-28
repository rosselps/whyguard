import type { ReactNode } from "react";

export type BadgeVariant = "neutral" | "brand" | "success" | "warning" | "danger" | "info";

const VARIANT_CLASSES: Record<BadgeVariant, string> = {
  neutral: "bg-wg-surface-2 text-wg-text-2 border-wg-border",
  brand: "bg-wg-brand-500/15 text-wg-brand-400 border-wg-brand-500/30",
  success: "bg-wg-success/15 text-wg-success border-wg-success/30",
  warning: "bg-wg-warning/15 text-wg-warning border-wg-warning/30",
  danger: "bg-wg-danger/15 text-wg-danger border-wg-danger/30",
  info: "bg-wg-info/15 text-wg-info border-wg-info/30",
};

export type BadgeProps = {
  variant?: BadgeVariant;
  children: ReactNode;
};

/**
 * Text-and-color badge primitive. Never renders color alone —
 * every usage passes readable text as `children`.
 */
export function Badge({ variant = "neutral", children }: BadgeProps) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-wg-sm border px-2 py-0.5 text-xs font-semibold ${VARIANT_CLASSES[variant]}`}
    >
      {children}
    </span>
  );
}
