import { Route, Routes } from "react-router-dom";
import { AppShell } from "./components/layout/AppShell.js";
import { DashboardPage } from "./pages/DashboardPage.js";
import { AnalysisPage } from "./pages/AnalysisPage.js";
import { DecisionPage } from "./pages/DecisionPage.js";
import { IntegrationsPage } from "./pages/IntegrationsPage.js";

/**
 * Route table and
 * `.kiro/steering/ui-ux.md`. Every route renders inside the canonical
 * `AppShell` — per the spec's consistency rule: "No crear
 * pantallas desde cero."
 */
export function App() {
  return (
    <AppShell>
      <Routes>
        <Route path="/" element={<DashboardPage />} />
        <Route path="/analyses/:analysisId" element={<AnalysisPage />} />
        <Route path="/decisions/:decisionId" element={<DecisionPage />} />
        <Route path="/settings/integrations" element={<IntegrationsPage />} />
      </Routes>
    </AppShell>
  );
}
