import type { ReactNode } from "react";

export type PanelProps = {
  children: ReactNode;
  className?: string;
};

/** Card/panel primitive: surface background, card radius, 16px padding. */
export function Panel({ children, className = "" }: PanelProps) {
  return (
    <div className={`rounded-wg-card border border-wg-border bg-wg-surface p-4 ${className}`}>
      {children}
    </div>
  );
}
