import Link from "next/link";

import { ThemeSelector } from "./theme-selector.tsx";
import type { ThemeMode } from "../lib/theme.ts";

interface SiteHeaderProps {
  themeMode: ThemeMode;
}

export function SiteHeader({ themeMode }: SiteHeaderProps) {
  return (
    <header className="site-header">
      <div className="site-header__inner">
        <Link className="brand" href="/" aria-label="NURITEO home">
          <span className="brand__mark" aria-hidden="true">
            N
          </span>
          <span>NURITEO</span>
        </Link>
        <div className="flex items-center gap-4">
          <nav aria-label="Public navigation">
            <Link className="text-sm font-medium text-muted-foreground no-underline transition-colors hover:text-foreground" href="/examples">
              Examples
            </Link>
          </nav>
          <ThemeSelector initialMode={themeMode} />
        </div>
      </div>
    </header>
  );
}
