"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

import { ThemeSelector } from "#src/components/theme-selector.tsx";
import type { ThemeMode } from "#src/lib/theme.ts";
import { LogoutButton } from "#src/app/(authenticated)/logout-button.tsx";

interface AuthenticatedNavigationProps {
  readonly displayName: string;
  readonly email: string;
  readonly isInstanceAdmin: boolean;
  readonly pathnameOverride?: string | undefined;
  readonly themeMode: ThemeMode;
  readonly unreadCount: number;
}

interface NavigationItem {
  readonly href: string;
  readonly icon: "home" | "project" | "organization" | "notification" | "security" | "identity" | "token" | "admin";
  readonly label: string;
  readonly matchPrefixes?: readonly string[];
}

const primaryNavigation: readonly NavigationItem[] = [
  { href: "/workspaces", icon: "home", label: "워크스페이스" },
  { href: "/projects", icon: "project", label: "프로젝트" },
  { href: "/organizations", icon: "organization", label: "조직" },
  { href: "/notifications", icon: "notification", label: "알림" }
];

const accountNavigation: readonly NavigationItem[] = [
  { href: "/mfa", icon: "security", label: "보안" },
  { href: "/identities", icon: "identity", label: "연결된 계정" },
  { href: "/access-tokens", icon: "token", label: "액세스 토큰" }
];

function NavigationIcon({ name }: Readonly<{ name: NavigationItem["icon"] }>) {
  const paths = {
    home: <><path d="m3 10 9-7 9 7" /><path d="M5 9v11h14V9" /><path d="M9 20v-7h6v7" /></>,
    project: <><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h3l2 2H18a2 2 0 0 1 2 2v11a3 3 0 0 1-3 3H6a2 2 0 0 1-2-2Z" /><path d="M4 8h16" /></>,
    organization: <><circle cx="9" cy="8" r="3" /><path d="M3.5 20a5.5 5.5 0 0 1 11 0" /><path d="M16 4.5a3 3 0 0 1 0 5.5M17 14a5 5 0 0 1 4 4.9" /></>,
    notification: <><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9" /><path d="M10 21h4" /></>,
    security: <><path d="M12 3 4.5 6v5.5c0 4.7 3.1 7.7 7.5 9.5 4.4-1.8 7.5-4.8 7.5-9.5V6Z" /><path d="m9 12 2 2 4-4" /></>,
    identity: <><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></>,
    token: <><circle cx="8" cy="15" r="4" /><path d="m11 12 8-8M15 8l3 3M17 6l2 2" /></>,
    admin: <><path d="M12 3 4.5 6v5.5c0 4.7 3.1 7.7 7.5 9.5 4.4-1.8 7.5-4.8 7.5-9.5V6Z" /><circle cx="12" cy="11" r="2.2" /><path d="M8.5 17a4 4 0 0 1 7 0" /></>
  } satisfies Record<NavigationItem["icon"], ReactNode>;

  return <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>;
}

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
    <Link
      aria-current={isCurrent ? "page" : undefined}
      aria-label={item.label}
      data-admin-entry={item.icon === "admin" ? "true" : undefined}
      href={item.href}
      title={item.label}
    >
      <span className="authenticated-navigation__icon"><NavigationIcon name={item.icon} /></span>
      <span>{item.label}</span>
      {unreadCount !== undefined && unreadCount > 0 ? (
        <span className="authenticated-navigation__badge" aria-label={`읽지 않은 알림 ${unreadCount}개`}>
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
  pathnameOverride,
  themeMode,
  unreadCount
}: AuthenticatedNavigationProps) {
  const pathname = pathnameOverride ?? usePathname();
  const adminNavigation: NavigationItem = {
    href: "/admin",
    icon: "admin",
    label: "관리자 홈",
    matchPrefixes: ["/admin"]
  };

  return (
    <aside className="authenticated-navigation">
      <Link className="authenticated-navigation__brand" href="/workspaces" aria-label="NURITEO 홈">
        <span aria-hidden="true">N</span>
        <strong>NURITEO</strong>
      </Link>

      <Link className="authenticated-navigation__workspace" href="/workspaces">
        <span><strong>워크스페이스</strong><small>작업 공간 전환</small></span>
        <b aria-hidden="true">→</b>
      </Link>

      <nav aria-label="주요 메뉴">
        <p className="authenticated-navigation__label">워크스페이스</p>
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
        <p className="authenticated-navigation__label">계정</p>
        {accountNavigation.map((item) => (
          <NavigationLink item={item} key={item.href} pathname={pathname} />
        ))}
        {isInstanceAdmin ? (
          <NavigationLink item={adminNavigation} pathname={pathname} />
        ) : null}
      </nav>

      <LogoutButton />

      <div className="authenticated-navigation__footer">
        <span className="authenticated-navigation__avatar">{userInitials(displayName)}</span>
        <span className="authenticated-navigation__user"><strong>{displayName}</strong><small>{email}</small></span>
        <ThemeSelector initialMode={themeMode} />
      </div>

      <details className="authenticated-navigation__mobile-more">
        <summary aria-label="계정 및 시스템 메뉴 열기">
          <span className="authenticated-navigation__mobile-more-icon" aria-hidden="true">•••</span>
          <span>더보기</span>
        </summary>
        <div className="authenticated-navigation__mobile-panel">
          <header>
            <span className="authenticated-navigation__avatar">{userInitials(displayName)}</span>
            <span className="authenticated-navigation__user"><strong>{displayName}</strong><small>{email}</small></span>
            <ThemeSelector initialMode={themeMode} />
          </header>
          <nav aria-label="모바일 계정 메뉴">
            {accountNavigation.map((item) => (
              <NavigationLink item={item} key={item.href} pathname={pathname} />
            ))}
            {isInstanceAdmin ? <NavigationLink item={adminNavigation} pathname={pathname} /> : null}
          </nav>
          <LogoutButton />
        </div>
      </details>
    </aside>
  );
}
