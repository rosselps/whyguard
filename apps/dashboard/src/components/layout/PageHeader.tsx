import type { ReactNode } from "react";

export type PageHeaderProps = {
  eyebrow?: string;
  title: string;
  description?: string;
  action?: ReactNode;
};

/** Page header: eyebrow + H1 + description + primary action. */
export function PageHeader({ eyebrow, title, description, action }: PageHeaderProps) {
  return (
    <div className="mb-6 flex items-start justify-between gap-4">
      <div>
        {eyebrow ? (
          <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-wg-muted">
            {eyebrow}
          </p>
        ) : null}
        <h1 className="text-2xl font-bold text-wg-text">{title}</h1>
        {description ? <p className="mt-1 text-sm text-wg-text-2">{description}</p> : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}
