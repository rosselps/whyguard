# Dashboard UI/UX

The visual system for `apps/dashboard`. Condensed from the approved v1.0 specification; the
prototype mockups were dropped because the implemented screens supersede them.

WhyGuard has to look like an engineering tool, not a generic AI dashboard. Four things must
be perceptible at a glance: protection, evidence, risk, action.

**The target:** a developer answers four questions in under 30 seconds — what changed, which
recorded decision might break, what evidence supports the alert, what is the safe next step.

## Principles

1. **Evidence before opinion.** Show the issue, PR, commit, test or contract first. The
   synthesis comes after, never before.
2. **Risk is always actionable.** High, medium and low are not decoration. Each leads
   somewhere: view the decision, generate a test, keep the protection, continue with a
   justification.
3. **Never block without an exit.** The guardrail can stop an operation, but always offers
   an auditable way forward.
4. **Controlled technical density.** The product is full of diffs, ids, commits and
   evidence. Reduce load with cards, hierarchy and short sentences — not by hiding data.
5. **Semantic consistency.** The same colour and component mean the same thing everywhere.
6. **Visible confidence.** Distinguish strong, partial and insufficient evidence. Never
   present an inference as a fact.

## Non-negotiable rules

A violation of any of these is a review failure, not a preference:

1. Every risk state renders as **icon + text label + colour**. Never colour alone.
2. Evidence appears **before** the model's explanation, in the DOM and on screen.
3. Domain enums drive labels and colours. The frontend never infers them from free text.
4. Semantic hex values never appear in domain components. They consume tokens and variants.
5. A generated test is shown for copying, never executed by the UI.
6. `prefers-reduced-motion` is respected, and nothing blinks.

## Colour

| Token | Hex | Use | Not for |
|---|---|---|---|
| `brand.500` | `#6C5CE7` | Primary action, selection, brand focus | Errors or success |
| `brand.400` | `#8778F5` | Hover, evidence lines, secondary elements | Long text |
| `accent` | `#00C2A8` | Verified evidence, the logo's node | Global primary action |
| `success` | `#20C77A` | Safe operation, protection preserved | Low risk with no text |
| `warning` | `#F5B940` | Medium risk, attention | A critical block |
| `danger` | `#FF5C6C` | High risk, protection removed | An ordinary primary button |
| `info` | `#4DA3FF` | Information, context links | Verification state |
| `canvas` | `#0B0F16` | Page background | Elevated cards |
| `surface` | `#111824` | Cards and navigation | Code |
| `surface.2` | `#151E2C` | Rows, inner panels | Canvas |
| `border` | `#273548` | Dividers and controls | Dominant decoration |
| `text.primary` | `#F7F9FC` | Titles and body | Disabled text |
| `text.secondary` | `#C7D0DC` | Secondary content | Very weak metadata |
| `text.muted` | `#8C9AAA` | Metadata, timestamps | Critical information |

Dark is the canonical theme. A light theme is roadmap, not a parallel variant.

### Risk semantics

| State | Colour | Meaning | Typical action |
|---|---|---|---|
| High | `danger` | May remove or weaken a critical protection | Review the decision first |
| Medium | `warning` | May affect important behavior | Validate evidence and tests |
| Low | `success` | Minor impact, or sufficiently protected | Continue with normal review |
| None | neutral | No protected decision affected | Do not block |

## Typography

| Role | Family | Size / line | Weight | Use |
|---|---|---|---|---|
| H1 | Inter | 28 / 34 | 700 | View title |
| H2 | Inter | 18 / 24 | 700 | Panel or block title |
| H3 | Inter | 14 / 20 | 700 | Subsection, alert |
| Body | Inter | 13 / 20 | 400 | Product text |
| Body strong | Inter | 13 / 20 | 600 | Values and concepts |
| Caption | Inter | 10 / 14 | 600 | Metadata, labels |
| Code | JetBrains Mono | 11 / 17 | 400 | Diffs, paths, hashes, snippets |

70–80 characters per line maximum in explanatory text. Sustained uppercase is reserved for
short labels, states and ids.

## Geometry

| Property | Value | Notes |
|---|---|---|
| Base spacing | 4 px | Scale: 4, 8, 12, 16, 20, 24, 32, 40, 48 |
| Sidebar | 246 px | Fixed at >= 1280 px |
| Content max | 1440 px | Centered on large screens |
| Card padding | 16 px | 24 px only for editorial blocks |
| Radius | 8 / 10 / 12 / 16 px | badge / control / card / panel |
| Border | 1 px | Hierarchy comes from background and border |
| Elevation | Very low | No neumorphism, no heavy shadows |

Responsive: desktop-first. At 1024–1279 px the sidebar compacts; below 768 px tables become
cards and only basic functionality is supported.

## Icons

Outline, 20 px, 1.75 px stroke, rounded caps. Lucide for generic icons.

| Concept | Icon | Rule |
|---|---|---|
| Summary | Home | Not an analytics chart |
| Analysis | Search / Scan | Investigation, not "magic AI" |
| Decisions | Shield / FileBadge | Must suggest protected memory |
| Evidence | GitCommit / Link | Always paired with a text type |
| Risk | TriangleAlert | Never colour alone |
| Test | FlaskConical | Distinct from a CI check |
| Integration | Cable / Plug | Connection state separate from the product |

## Components

| Level | Components |
|---|---|
| Primitives | Button, IconButton, Badge, Input, Tooltip, Divider, Spinner, Skeleton |
| Layout | AppShell, Sidebar, Topbar, PageHeader, Panel |
| Domain | RiskBadge, DecisionCard, EvidenceItem, EvidenceTimeline, ProtectedProperty, DiffViewer, ActionBar |
| Feedback | HistoricalRiskAlert, EmptyState, ErrorState |
| Integration | IntegrationStatus |

Button variants: `primary` (one dominant per block), `secondary`, `success` (keep the
protection), `danger` (continue with a justification — always with explicit text, never an
icon alone), `ghost`.

Compose new screens from AppShell plus these components. A visual exception has to be
recorded as a design decision, not improvised.

## Routes

| Route | Goal | Primary action |
|---|---|---|
| `/` | Orient the user, show pending work | Analyze a pull request |
| `/analyses/:id` | Decide whether a change threatens a protection | View decision / generate test |
| `/decisions/:id` | Understand and preserve a historical reason | Generate test |
| `/settings/integrations` | Confirm the product is connected | Configure / revalidate |

## Screen rules

**Dashboard.** Orientation, not deep analysis. Metric cards, recent analyses, recommended
actions. Loading uses skeletons that keep the layout stable. A partial failure shows an error
card in the affected block only, never blocks the whole page. Zero risks is a positive
message, not an alarming empty chart.

**Analysis.** Mandatory order: risk and decision first, evidence second, action last. The
diff shows only the relevant fragment, not the whole pull request. The evidence timeline
shows the 3–5 strongest items.

**Decision.** Five sections, each answering one question: the reason (why does it exist), the
behavior to preserve (what must stay true), the evidence lineage (what facts support it), the
regression test (is there an executable check), status and confidence (how strong, and when
was it last reviewed).

The decision page must make clear that WhyGuard protects a **property, not a line** — an
implementation can be replaced when the new one preserves the property.

**Kiro guardrail.** A persistent panel, not a generic modal: the evidence has to stay visible
while the human decides. On engine timeout or error, never block indefinitely — say "could
not verify" and apply the configured policy.

## Domain enums

The frontend maps these to components. It never derives a label or colour from free text.

| Category | Values |
|---|---|
| Risk | `high`, `medium`, `low`, `none` |
| Evidence | `verified`, `partial`, `insufficient` |
| Analysis | `queued`, `running`, `completed`, `failed` |
| Decision | `candidate`, `verified`, `superseded`, `expired` |
| Test | `missing`, `suggested`, `generated`, `linked`, `passing`, `failing` |
| Integration | `connected`, `degraded`, `disconnected` |

## Microcopy

Precise, technical, calm. WhyGuard reports risk; it never blames. Concrete verbs: remove,
preserve, link, demonstrate, justify.

The UI text is Spanish. These pairs are the rule, not examples to paraphrase:

| Avoid | Prefer |
|---|---|
| "La IA cree que esto está mal" | "Este cambio elimina una validación asociada con Issue #481 y PR #493." |
| "Error crítico" with no context | "Protección histórica potencialmente afectada." |
| "Aceptar riesgo" | "Continuar con justificación." |
| "Fix with AI" | "Generar prueba sugerida." |
| "Confidence 0.91" | "Confianza 91% · evidencia fuerte." |
| Long paragraphs in an alert | One sentence plus "Ver evidencia" |

## Interaction

| Interaction | Specification |
|---|---|
| Hover | 120–160 ms, slight background or border change, never displacement |
| Focus | Visible 2 px `brand.400` ring with 2 px offset |
| Expand / collapse | 180–220 ms ease-out, respecting reduced-motion |
| Risk alert | No looping animation |
| Generate test | Progress plus a text status. Never an unexplained spinner |
| Copy hash or path | Discreet "Copiado" toast |
| Continue with justification | Short form requiring a reason |

## Accessibility

Target WCAG 2.2 AA. Full validation needs manual testing with assistive technology and
expert review; the rules below are the floor, not the proof.

- Every primary interaction is keyboard operable, with visible focus.
- Risk badges carry text. Diffs prefix `+` / `-` rather than relying on red and green.
- Interactive icons have an accessible name; decorative ones are hidden from the tree.
- The evidence timeline is a semantically ordered list.
- The guardrail uses `role="status"` or `role="alert"` by severity, and never steals focus
  except on an explicit block.

## Tokens

```css
:root {
  --wg-brand-500: #6c5ce7;
  --wg-brand-400: #8778f5;
  --wg-accent: #00c2a8;
  --wg-success: #20c77a;
  --wg-warning: #f5b940;
  --wg-danger: #ff5c6c;
  --wg-info: #4da3ff;

  --wg-canvas: #0b0f16;
  --wg-surface: #111824;
  --wg-surface-2: #151e2c;
  --wg-border: #273548;
  --wg-text: #f7f9fc;
  --wg-text-2: #c7d0dc;
  --wg-muted: #8c9aaa;

  --wg-radius-sm: 8px;
  --wg-radius-md: 10px;
  --wg-radius-card: 12px;
  --wg-radius-lg: 16px;
}
```

`styles/tokens.css` is the source of truth for these values, not this table.

## Stack deviation, on the record

The specification recommended Next.js with the App Router. `apps/dashboard` uses **Vite +
React + Tailwind**, because the dashboard is a read-only client of an existing API with no
server-rendering requirement, and a static build deploys to any static host.

That is a deliberate deviation, recorded here rather than left as a silent substitution.
Tailwind, Zod and Vitest follow the specification. Storybook, TanStack Query, React Hook Form
and Playwright were not adopted at this scale.
