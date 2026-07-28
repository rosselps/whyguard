/**
 * Finding state transitions:
 *
 *   proposed -> confirmed
 *   proposed -> rejected
 *   confirmed -> replaced
 *   confirmed -> expired
 *   replaced -> active(new decision)
 *
 * Every transition must record actor, timestamp, and reason (enforced by the caller
 * via the `TransitionRecord` shape below).
 */
export type FindingState = "proposed" | "confirmed" | "rejected" | "replaced" | "expired";

const ALLOWED_TRANSITIONS: Record<FindingState, FindingState[]> = {
  proposed: ["confirmed", "rejected"],
  confirmed: ["replaced", "expired"],
  rejected: [],
  replaced: [],
  expired: [],
};

export type TransitionRecord = {
  from: FindingState;
  to: FindingState;
  actor: string;
  timestamp: string;
  reason: string;
};

export class InvalidFindingTransitionError extends Error {
  constructor(from: FindingState, to: FindingState) {
    super(`Invalid finding state transition: ${from} -> ${to}`);
    this.name = "InvalidFindingTransitionError";
  }
}

export function canTransition(from: FindingState, to: FindingState): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export function applyTransition(
  from: FindingState,
  to: FindingState,
  actor: string,
  reason: string,
  now: () => string = () => new Date().toISOString(),
): TransitionRecord {
  if (!canTransition(from, to)) {
    throw new InvalidFindingTransitionError(from, to);
  }
  return { from, to, actor, timestamp: now(), reason };
}
