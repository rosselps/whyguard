import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// WhyGuard dashboard (Phase 5). Vite + React, per the confirmed, documented
// deviation from the canonical UI/UX spec's Next.js recommendation — see
//.kiro/steering/ui-ux.md and AGENTS.md's Phase 5 notes.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
  },
});
