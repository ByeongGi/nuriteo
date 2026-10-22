import Link from "next/link";

import { ThemeSelector } from "#src/components/theme-selector.tsx";
import type { ThemeMode } from "#src/lib/theme.ts";

interface SiteHeaderProps {
  themeMode: ThemeMode;
}

export function SiteHeader({ themeMode }: SiteHeaderProps) {
  return (
    <header className="site-header">
      <div className="site-header__inner">
        <Link className="brand" href="/" aria-label="NURITEO 홈">
          <span className="brand__mark" aria-hidden="true">
            N
          </span>
          <span>NURITEO</span>
        </Link>
        <div className="flex items-center gap-4">
          <nav aria-label="공개 메뉴">
            <Link className="text-sm font-medium text-muted-foreground no-underline transition-colors hover:text-foreground" href="/examples">
              예제
            </Link>
          </nav>
          <ThemeSelector initialMode={themeMode} />
        </div>
      </div>
    </header>
  );
}
