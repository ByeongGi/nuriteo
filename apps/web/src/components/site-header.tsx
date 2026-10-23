"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { tv } from "tailwind-variants";

import { ThemeSelector } from "#src/components/theme-selector.tsx";
import type { ThemeMode } from "#src/lib/theme.ts";

interface SiteHeaderProps {
  themeMode: ThemeMode;
}

const siteHeaderStyles = tv({
  slots: {
    root: "min-h-[var(--n-layout-header-height)] border-b border-muted-border bg-sidebar",
    inner: "mx-auto flex min-h-[var(--n-layout-header-height)] max-w-[var(--n-layout-content-max)] items-center justify-between gap-4 px-[var(--n-layout-content-gutter)]",
    brand: "inline-flex items-center gap-2 text-xs font-semibold tracking-[0.12em] text-foreground no-underline",
    mark: "grid size-7 place-items-center rounded-md border border-border bg-surface tracking-normal text-accent-foreground",
    actions: "flex items-center gap-4"
  }
});

export function SiteHeader({ themeMode }: SiteHeaderProps) {
  const pathname = usePathname();
  const styles = siteHeaderStyles();
  const isPublicRoute = pathname === "/" || pathname.startsWith("/examples");

  if (!isPublicRoute) return null;

  return (
    <header className={styles.root()}>
      <div className={styles.inner()}>
        <Link className={styles.brand()} href="/" aria-label="NURITEO 홈">
          <span className={styles.mark()} aria-hidden="true">
            N
          </span>
          <span>NURITEO</span>
        </Link>
        <div className={styles.actions()}>
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
