/**
 * Shared timestamp formatting helper. Locale-agnostic ISO-ish display; the MVP
 * doesn't need i18n.
 */
/**
 * Renders a repository name for display.
 *
 * GitHub-sourced analyses store a clean `owner/repo`-style name, but a local CLI scan
 * stores the absolute path it was run against — which renders as an unreadable
 * `C:\Users\...\projects\code\iot\iotr` that pushes the useful part off the row and
 * needlessly shows the operator's directory layout on screen. The trailing segment is
 * the part a reader recognizes, so show that and keep the full path in a tooltip.
 *
 * Escaped double separators are normalized first: older rows were written with
 * JSON-escaped backslashes, and splitting naively left stray `\` in the result.
 */
export function formatRepositoryName(name: string): string {
  const normalized = name.replace(/\\\\/g, "\\");
  if (!/[\\/]/.test(normalized)) return normalized;

  const segments = normalized.split(/[\\/]/).filter((segment) => segment.length > 0);
  return segments[segments.length - 1] ?? normalized;
}

export function formatTimestamp(iso: string): string {
  try {
    return new Date(iso).toLocaleString("es-ES", {
      dateStyle: "medium",
      timeStyle: "short",
    });
  } catch {
    return iso;
  }
}
