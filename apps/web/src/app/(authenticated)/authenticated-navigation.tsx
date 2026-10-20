"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { ThemeSelector } from "../../components/theme-selector.tsx";
import type { ThemeMode } from "../../lib/theme.ts";

interface AuthenticatedNavigationProps {
  readonly displayName: string;
  readonly email: string;
  readonly isInstanceAdmin: boolean;
  readonly themeMode: ThemeMode;
  readonly unreadCount: number;
}

interface NavigationItem {
  readonly href: string;
  readonly icon: string;
  readonly label: string;
  readonly matchPrefixes?: readonly string[];
}

const primaryNavigation: readonly NavigationItem[] = [
  { href: "/workspaces", icon: "⌂", label: "홈" },
  { href: "/projects", icon: "P", label: "프로젝트" },
  { href: "/organizations", icon: "O", label: "조직" },
  { href: "/notifications", icon: "●", label: "알림" }
];

const accountNavigation: readonly NavigationItem[] = [
  { href: "/mfa", icon: "◇", label: "보안" },
  { href: "/identities", icon: "I", label: "연결된 계정" },
  { href: "/access-tokens", icon: "T", label: "액세스 토큰" }
];

function isCurrentRoute(pathname: string, item: NavigationItem): boolean {
  const prefixes = item.matchPrefixes ?? [item.href];
  return prefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

function userInitials(displayName: string): string {
  const characters = Array.from(displayName.trim());
  return characters.slice(0, 2).join("").toUpperCase() || "N";
}

function NavigationLink({ item, pathname, unreadCount }: Readonly<{
  item: NavigationItem;
  pathname: string;
  unreadCount?: number;
}>) {
  const isCurrent = isCurrentRoute(pathname, item);

  return (
    <Link aria-current={isCurrent ? "page" : undefined} aria-label={item.label} href={item.href}>
      <span className="authenticated-navigation__icon" aria-hidden="true">{item.icon}</span>
      <span>{item.label}</span>
      {unreadCount !== undefined && unreadCount > 0 ? (
        <span className="authenticated-navigation__badge" aria-label={`${unreadCount} unread notifications`}>
          {unreadCount > 99 ? "99+" : unreadCount}
        </span>
      ) : null}
    </Link>
  );
}

export function AuthenticatedNavigation({
  displayName,
  email,
  isInstanceAdmin,
  themeMode,
  unreadCount
}: AuthenticatedNavigationProps) {
  const pathname = usePathname();

  return (
    <aside className="authenticated-navigation">
      <Link className="authenticated-navigation__brand" href="/workspaces" aria-label="NURITEO 홈">
        <span aria-hidden="true">N</span>
        <strong>NURITEO</strong>
      </Link>

      <Link className="authenticated-navigation__workspace" href="/workspaces">
        <span><strong>내 워크스페이스</strong><small>Workspace</small></span>
        <b aria-hidden="true">⌄</b>
      </Link>

      <nav aria-label="주요 메뉴">
        {primaryNavigation.map((item) => (
          <NavigationLink
            item={item}
            key={item.href}
            pathname={pathname}
            {...(item.href === "/notifications" ? { unreadCount } : {})}
          />
        ))}
      </nav>

      <nav className="authenticated-navigation__account" aria-label="계정 메뉴">
        <p>계정</p>
        {accountNavigation.map((item) => (
          <NavigationLink item={item} key={item.href} pathname={pathname} />
        ))}
        {isInstanceAdmin ? (
          <NavigationLink
            item={{ href: "/admin/settings", icon: "A", label: "관리" }}
            pathname={pathname}
          />
        ) : null}
      </nav>

      <div className="authenticated-navigation__footer">
        <span className="authenticated-navigation__avatar">{userInitials(displayName)}</span>
        <span className="authenticated-navigation__user"><strong>{displayName}</strong><small>{email}</small></span>
        <ThemeSelector initialMode={themeMode} />
      </div>
    </aside>
  );
}
