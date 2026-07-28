import type { ReactNode } from "react";
import { Sidebar } from "./Sidebar.js";
import { Topbar } from "./Topbar.js";

export type AppShellProps = {
  children: ReactNode;
};

/**
 * Canonical page shell. Every route composes with this —
 * no screen is built "from scratch" (spec's consistency rule, also section
 * 30.1: "Pantalla nueva sin AppShell" breaks CI). Canvas background, content
 * max-width 1440px, centered on large screens.
 */
export function AppShell({ children }: AppShellProps) {
  return (
    <div className="flex min-h-screen bg-wg-canvas text-wg-text">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar />
        <main className="flex-1 overflow-x-hidden p-6">
          <div className="mx-auto max-w-[1440px]">{children}</div>
        </main>
      </div>
    </div>
  );
}
