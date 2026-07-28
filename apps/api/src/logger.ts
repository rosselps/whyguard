/**
 * Minimal structured logger for apps/api. Every log line is prefixed with a
 * level and the `[whyguard-api]` tag so operators can grep logs quickly and
 * tell WhyGuard's own output apart from Express/Node noise. Deliberately not a
 * full logging library (pino/winston) — this is a small local dev tool, not a
 * production service; structured-log-field guidance is honored in
 * spirit (event name + correlation-style fields) without the dependency.
 *
 * Never log secrets: callers must pass only redacted/derived values (e.g.
 * "present, length=40" instead of the actual secret).
 */

type LogFields = Record<string, string | number | boolean | undefined>;

function formatFields(fields?: LogFields): string {
  if (!fields) return "";
  const parts = Object.entries(fields)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`);
  return parts.length > 0 ? ` ${parts.join(" ")}` : "";
}

export function logInfo(message: string, fields?: LogFields): void {
  console.error(`[whyguard-api] INFO  ${message}${formatFields(fields)}`);
}

export function logWarn(message: string, fields?: LogFields): void {
  console.error(`[whyguard-api] WARN  ${message}${formatFields(fields)}`);
}

export function logError(message: string, fields?: LogFields): void {
  console.error(`[whyguard-api] ERROR ${message}${formatFields(fields)}`);
}
