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
        <ThemeSelector initialMode={themeMode} />
      </div>
    </header>
  );
}
