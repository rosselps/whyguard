import type { Config } from "tailwindcss";

/**
 * Tailwind theme mapped 1:1 to the token variables in `src/styles/tokens.css`,
 * which mirror the UI/UX spec's palette verbatim.
 * Per that doc's rule:
 * domain components must never hardcode a semantic hex color — they consume
 * `bg-wg-*` / `text-wg-*` / `border-wg-*` classes, which resolve through these
 * CSS variables. Changing a brand color means editing tokens.css, never a
 * component file.
 */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        "wg-brand-500": "var(--wg-brand-500)",
        "wg-brand-400": "var(--wg-brand-400)",
        "wg-accent": "var(--wg-accent)",
        "wg-success": "var(--wg-success)",
        "wg-warning": "var(--wg-warning)",
        "wg-danger": "var(--wg-danger)",
        "wg-info": "var(--wg-info)",
        "wg-canvas": "var(--wg-canvas)",
        "wg-surface": "var(--wg-surface)",
        "wg-surface-2": "var(--wg-surface-2)",
        "wg-border": "var(--wg-border)",
        "wg-text": "var(--wg-text)",
        "wg-text-2": "var(--wg-text-2)",
        "wg-muted": "var(--wg-muted)",
      },
      borderRadius: {
        "wg-sm": "var(--wg-radius-sm)",
        "wg-md": "var(--wg-radius-md)",
        "wg-card": "var(--wg-radius-card)",
        "wg-lg": "var(--wg-radius-lg)",
      },
      fontFamily: {
        sans: ["Inter", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "ui-monospace", "SFMono-Regular", "monospace"],
      },
    },
  },
  plugins: [],
} satisfies Config;
