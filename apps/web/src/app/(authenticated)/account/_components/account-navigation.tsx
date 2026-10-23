"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { tv } from "tailwind-variants";

const accountNavigationStyles = tv({
  slots: {
    root: "flex gap-0.5 overflow-x-auto border-b border-muted-border pb-3 [scrollbar-width:none] lg:block lg:overflow-visible lg:border-r lg:border-b-0 lg:pr-4 lg:pb-0",
    link: "flex min-h-8 shrink-0 items-center rounded-md px-2.5 text-xs font-medium text-muted-foreground no-underline transition-colors hover:bg-hover hover:text-foreground aria-[current=page]:bg-active aria-[current=page]:text-foreground",
    label: "truncate"
  }
});

const accountItems = [
  { href: "/account", label: "개요", exact: true },
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
        const current = "exact" in item && item.exact
          ? pathname === item.href
          : pathname === item.href || pathname.startsWith(`${item.href}/`);
        return (
          <Link
            aria-current={current ? "page" : undefined}
            className={styles.link()}
            href={item.href}
            key={item.href}
          >
            <span className={styles.label()}>{item.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}

