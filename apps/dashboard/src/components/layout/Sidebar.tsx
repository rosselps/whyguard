import { Shield, Home, Settings } from "lucide-react";
import { NavLink } from "react-router-dom";

/**
 * Fixed sidebar: logo, primary navigation, no future-menu placeholders. 246px.
 *
 * Only links to routes that actually exist. Analyses and
 * decisions are reached from the Dashboard's tables, not from the sidebar: never show a placeholder link to a page that doesn't
 * exist yet.
 */
export function Sidebar() {
  return (
    <aside className="hidden w-[246px] shrink-0 flex-col border-r border-wg-border bg-wg-surface p-4 lg:flex">
      <div className="mb-6 flex items-center gap-2 px-2">
        <Shield className="h-6 w-6 text-wg-accent" aria-hidden="true" />
        <span className="text-base font-bold text-wg-text">WhyGuard</span>
      </div>
      <nav className="flex flex-col gap-1" aria-label="Primary">
        <NavItem
          to="/"
          icon={<Home className="h-4 w-4" aria-hidden="true" />}
          label="Dashboard"
          end
        />
        <NavItem
          to="/settings/integrations"
          icon={<Settings className="h-4 w-4" aria-hidden="true" />}
          label="Integraciones"
        />
      </nav>
    </aside>
  );
}

function NavItem({
  to,
  icon,
  label,
  end,
}: {
  to: string;
  icon: React.ReactNode;
  label: string;
  end?: boolean;
}) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        `flex items-center gap-2 rounded-wg-md px-3 py-2 text-sm font-medium transition-colors duration-150 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-wg-brand-400 ${
          isActive
            ? "bg-wg-surface-2 text-wg-text"
            : "text-wg-text-2 hover:bg-wg-surface-2 hover:text-wg-text"
        }`
      }
    >
      {icon}
      {label}
    </NavLink>
  );
}
