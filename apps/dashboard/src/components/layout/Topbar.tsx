import { HelpCircle } from "lucide-react";

/**
 * Single horizontal topbar. MVP scope keeps this minimal — search/avatar are
 * roadmap, not faked placeholders.
 */
export function Topbar() {
  return (
    <header className="flex h-14 items-center justify-end gap-3 border-b border-wg-border bg-wg-surface px-6">
      <a
        href="https://github.com/rosselps/whyguard"
        target="_blank"
        rel="noreferrer"
        className="flex items-center gap-1 rounded-wg-md p-2 text-wg-text-2 hover:text-wg-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-wg-brand-400"
        aria-label="Ayuda"
      >
        <HelpCircle className="h-5 w-5" aria-hidden="true" />
      </a>
    </header>
  );
}
