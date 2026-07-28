import type { ProtectedProperty } from "@whyguard/contracts";

let counter = 0;

/** Deterministic ID generator for protected properties within a single process run. */
function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}_${counter.toString().padStart(3, "0")}`;
}

export function resetProtectedPropertyIdCounterForTests(): void {
  counter = 0;
}

export function proposeProtectedProperty(
  statement: string,
  category: ProtectedProperty["category"],
): ProtectedProperty {
  return {
    id: nextId("pp"),
    statement,
    category,
    status: "proposed",
  };
}
