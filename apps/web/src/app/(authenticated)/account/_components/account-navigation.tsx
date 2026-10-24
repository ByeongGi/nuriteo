"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { tv } from "tailwind-variants";

const accountNavigationStyles = tv({
  slots: {
    root: "flex gap-1 overflow-x-auto border-b border-muted-border [scrollbar-width:none]",
    link: "relative flex min-h-9 shrink-0 items-center gap-1.5 border-b-2 border-transparent px-2.5 text-xs font-medium text-muted-foreground no-underline transition-colors hover:bg-hover hover:text-foreground aria-[current=page]:border-primary aria-[current=page]:text-foreground",
    icon: "grid size-3.5 shrink-0 place-items-center text-subtle-foreground [&_svg]:size-3.5",
    label: "truncate"
  }
});

const accountItems = [
  { href: "/account/security", label: "보안" },
  { href: "/account/identities", label: "연결된 로그인" },
  { href: "/account/tokens", label: "개인 토큰" },
  { href: "/account/notifications", label: "알림 설정" }
] as const;

export function AccountNavigation() {
  const pathname = usePathname();
  const styles = accountNavigationStyles();

  return (
    <nav className={styles.root()} aria-label="계정 설정">
      {accountItems.map((item) => {
        const current = pathname === item.href || pathname.startsWith(`${item.href}/`);
        return (
          <Link
            aria-current={current ? "page" : undefined}
            className={styles.link()}
            href={item.href}
            key={item.href}
          >
            <span className={styles.icon()}><AccountNavigationIcon href={item.href} /></span>
            <span className={styles.label()}>{item.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}

function AccountNavigationIcon({ href }: Readonly<{ href: string }>) {
  let path: ReactNode;
  switch (href) {
    case "/account/security":
      path = <><path d="M12 3 5 6v5c0 4.5 2.8 7.3 7 9 4.2-1.7 7-4.5 7-9V6Z" /><path d="M9.5 12 11 13.5l3.5-4" /></>;
      break;
    case "/account/identities":
      path = <><circle cx="8" cy="12" r="3" /><circle cx="16" cy="12" r="3" /><path d="M11 12h2" /></>;
      break;
    case "/account/tokens":
      path = <><circle cx="8" cy="12" r="3" /><path d="M11 12h9M17 12v3M14 12v2" /></>;
      break;
    case "/account/notifications":
      path = <><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9" /><path d="M10 21h4" /></>;
      break;
    default:
      path = null;
  }
  return <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">{path}</svg>;
}

