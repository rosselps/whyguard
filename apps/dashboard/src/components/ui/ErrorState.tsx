export type ErrorStateProps = {
  message: string;
};

/**
 * Error-state primitive. Callers place this only
 * around the specific panel that failed, not the whole page.
 */
export function ErrorState({ message }: ErrorStateProps) {
  return (
    <div
      role="alert"
      className="flex items-start gap-2 rounded-wg-card border border-wg-danger/30 bg-wg-danger/10 p-4 text-sm text-wg-danger"
    >
      <span>{message}</span>
    </div>
  );
}
