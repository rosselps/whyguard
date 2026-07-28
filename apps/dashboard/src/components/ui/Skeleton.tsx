export type SkeletonProps = {
  className?: string;
};

/** Loading placeholder. Keeps layout structure stable while data loads. */
export function Skeleton({ className = "h-4 w-full" }: SkeletonProps) {
  return (
    <div
      className={`animate-pulse rounded-wg-sm bg-wg-surface-2 ${className}`}
      aria-hidden="true"
    />
  );
}
