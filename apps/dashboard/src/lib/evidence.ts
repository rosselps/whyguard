import type { EvidenceStrength } from "@whyguard/contracts";

/**
 * Names a single evidence item's `strength` for the reader.
 *
 * Deliberately *not* the "insufficient" vocabulary the UI uses for a finding's overall
 * confidence: that describes the verdict, this describes one item. `weak` is a real
 * signal — a commit that changed the line without explaining why — and labelling it
 * "insufficient" in red next to a critical finding backed by strong contract evidence
 * says the opposite of what the verdict says.
 */
export function evidenceStrengthLabel(strength: EvidenceStrength): string {
  switch (strength) {
    case "strong":
      return "evidencia fuerte";
    case "medium":
      return "evidencia media";
    case "weak":
      return "evidencia débil";
    default:
      return strength;
  }
}

export function evidenceStrengthVariant(
  strength: EvidenceStrength,
): "success" | "warning" | "neutral" {
  switch (strength) {
    case "strong":
      return "success";
    case "medium":
      return "warning";
    // Neutral, not danger: a weak item is worth less, not wrong, and red here reads as
    // an error in the analysis rather than as a grade on one piece of it.
    case "weak":
      return "neutral";
  }
}
