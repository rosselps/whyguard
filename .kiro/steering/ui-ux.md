---
inclusion: fileMatch
fileMatchPattern: 'apps/dashboard/**'
---

# WhyGuard — dashboard UI/UX

Full system: `docs/design/ui-ux.md`. Read it before building or changing a screen. This file
carries only the rules that are easy to break by accident.

## Never

1. Communicate a risk state by colour alone. Always icon + text label + colour.
2. Place the model's explanation before the evidence, in the DOM or on screen.
3. Infer a label or colour from free text. Domain enums drive both.
4. Write a semantic hex value in a domain component. Consume tokens and variants from
   `styles/tokens.css`.
5. Execute a generated test. The UI offers it for copying.
6. Animate in a loop, or ignore `prefers-reduced-motion`.
7. Build a screen from scratch. Compose AppShell plus the existing components; record a
   visual exception as a decision.

## Always

- Risk leads, evidence follows, action closes. That order is the product's argument.
- Say "unknown" out loud when evidence is weak. Hiding it is worse than showing it.
- Keep the guardrail's evidence visible while the human decides — a panel, not a modal.
- Make clear the tool protects a **property, not a line**: an implementation may be replaced
  when the property survives.
- Microcopy is precise, technical and calm, in Spanish, and never blames the developer. The
  avoid/prefer pairs in the design doc are rules, not examples to paraphrase.

## Stack

`apps/dashboard` is Vite + React + Tailwind. The specification recommended Next.js; the
deviation is deliberate and recorded in `docs/design/ui-ux.md`. Do not "restore" Next.js
without a decision.
