import type { ProtectedProperty as ProtectedPropertyDto } from "@whyguard/contracts";
import { ShieldCheck } from "lucide-react";

export type ProtectedPropertyProps = {
  property: ProtectedPropertyDto;
};

/**
 * Renders a single protected property statement. Per spec "SEPARAR RAZÓN DE IMPLEMENTACIÓN" rule, this always shows the *behavior*
 * statement (e.g. "one idempotency key creates at most one order"), never a
 * line of code — WhyGuard protects behavior, not implementation.
 */
export function ProtectedProperty({ property }: ProtectedPropertyProps) {
  return (
    <li className="flex items-start gap-2 text-sm text-wg-text-2">
      <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-wg-success" aria-hidden="true" />
      <span>{property.statement}</span>
    </li>
  );
}
