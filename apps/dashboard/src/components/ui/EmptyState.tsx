import type { ReactNode } from "react";

export type EmptyStateProps = {
  title: string;
  description?: string;
  action?: ReactNode;
};

/**
 * Empty-state primitive. Used whenever a query resolves successfully with no data.
 */
export function EmptyState({ title, description, action }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-wg-card border border-dashed border-wg-border p-10 text-center">
      <p className="text-sm font-semibold text-wg-text">{title}</p>
      {description ? <p className="text-sm text-wg-muted">{description}</p> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}
