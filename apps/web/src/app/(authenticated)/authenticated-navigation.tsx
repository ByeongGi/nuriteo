"use client";

import type { Workspace } from "@nuriteo/api-client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { tv } from "tailwind-variants";

import { ThemeSelector } from "#src/components/theme-selector.tsx";
import { CollapsibleContent, CollapsiblePanel, CollapsibleRoot, CollapsibleTrigger } from "#src/components/ui/collapsible.tsx";
import type { ThemeMode } from "#src/lib/theme.ts";
import { workspaceOwnerLabel } from "#src/lib/workspace-selection.ts";
import { LogoutButton } from "#src/app/(authenticated)/logout-button.tsx";

interface AuthenticatedNavigationProps {
  readonly displayName: string;
  readonly email: string;
  readonly isInstanceAdmin: boolean;
  readonly pathnameOverride?: string | undefined;
  readonly themeMode: ThemeMode;
  readonly unreadCount: number;
  readonly workspaces: readonly Workspace[];
}

interface NavigationItem {
  readonly exact?: boolean;
  readonly href: string;
  readonly icon: "workspace" | "notification" | "account" | "admin";
  readonly label: string;
  readonly matchPrefixes?: readonly string[];
}

const navigationStyles = tv({
  slots: {
    root: "sticky top-0 z-[var(--n-z-sticky)] flex h-screen flex-col bg-sidebar px-2 pb-2 pt-2 max-[48rem]:fixed max-[48rem]:inset-x-0 max-[48rem]:top-auto max-[48rem]:bottom-0 max-[48rem]:grid max-[48rem]:h-16 max-[48rem]:grid-cols-[minmax(0,1fr)_3.75rem] max-[48rem]:gap-1 max-[48rem]:border-t max-[48rem]:border-muted-border max-[48rem]:px-3 max-[48rem]:py-1",
    brand: "flex min-h-9 items-center gap-2 rounded-md px-2 text-sm font-semibold tracking-[0.08em] text-foreground no-underline hover:bg-hover max-[48rem]:hidden",
    brandMark: "grid size-6 place-items-center rounded-md bg-primary text-[0.6875rem] font-semibold tracking-normal text-on-primary shadow-xs",
    brandLabel: "",
    workspaceCard: "mt-2 flex min-h-12 items-center justify-between gap-2 rounded-md border border-muted-border/70 bg-[color-mix(in_srgb,var(--n-color-bg-surface)_38%,transparent)] px-2.5 py-2 no-underline hover:bg-hover max-[48rem]:hidden",
    workspaceCopy: "grid min-w-0 gap-0.5 [&_strong]:truncate [&_strong]:text-xs [&_small]:truncate [&_small]:text-[var(--n-font-size-2xs)] [&_small]:text-subtle-foreground",
    workspaceArrow: "text-xs text-subtle-foreground",
    nav: "mt-4 grid gap-0.5",
    workspaceNav: "max-[48rem]:m-0 max-[48rem]:grid max-[48rem]:h-full max-[48rem]:grid-cols-1 max-[48rem]:gap-1",
    collaborationNav: "max-[48rem]:hidden",
    accountNav: "mt-5 max-[48rem]:hidden",
    label: "mb-1 px-2.5 text-[0.625rem] font-semibold tracking-[0.05em] text-subtle-foreground max-[48rem]:hidden",
    footer: "mt-2 grid grid-cols-[1.75rem_minmax(0,1fr)] items-center gap-2 border-t border-muted-border/70 px-1 pt-2 max-[48rem]:hidden",
    avatar: "grid size-7 place-items-center rounded-md bg-selected text-[var(--n-font-size-2xs)] font-semibold text-link",
    user: "grid min-w-0 [&_strong]:truncate [&_strong]:text-xs [&_small]:truncate [&_small]:text-[var(--n-font-size-2xs)] [&_small]:text-subtle-foreground",
    theme: "col-span-full w-full",
    themeTrigger: "w-full max-w-none",
    mobileMore: "relative hidden min-w-0 max-[48rem]:block",
    mobileTrigger: "grid h-full min-h-0 w-full place-content-center justify-items-center gap-0.5 whitespace-nowrap rounded-md text-[0.6875rem] font-medium text-muted-foreground marker:content-none data-[panel-open]:bg-selected data-[panel-open]:text-foreground",
    mobileMoreIcon: "text-base leading-[0.75] tracking-[0.08em]",
    mobilePanel: "fixed right-3 bottom-[calc(4rem+0.75rem)] grid w-[min(21rem,calc(100vw-1.5rem))] gap-3 rounded-xl border border-strong-border bg-raised p-4 shadow-lg",
    mobileHeader: "grid grid-cols-[2rem_minmax(0,1fr)_auto] items-center gap-2 border-b border-muted-border pb-3",
    mobileUser: "grid min-w-0 [&_small]:truncate [&_small]:text-xs [&_small]:text-subtle-foreground",
    mobileThemeTrigger: "w-auto",
    mobileNav: "grid gap-1"
  }
});

const navigationLinkStyles = tv({
  slots: {
    link: "relative grid min-h-8 grid-cols-[1rem_minmax(0,1fr)_auto] items-center gap-2 rounded-md px-2.5 text-xs font-medium text-muted-foreground no-underline transition-colors hover:bg-hover hover:text-foreground aria-[current=page]:bg-active aria-[current=page]:text-foreground max-[48rem]:min-h-0 max-[48rem]:h-full max-[48rem]:grid-cols-1 max-[48rem]:grid-rows-[1.25rem_auto] max-[48rem]:content-center max-[48rem]:gap-0.5 max-[48rem]:px-0 max-[48rem]:py-1 max-[48rem]:text-[0.6875rem]",
    icon: "grid size-4 place-items-center [&_svg]:size-4",
    label: "min-w-0 truncate max-[48rem]:block max-[48rem]:max-w-full",
    badge: "grid h-4 min-w-4 place-items-center rounded-full bg-primary px-1 text-[0.625rem] text-on-primary max-[48rem]:absolute max-[48rem]:ml-5 max-[48rem]:-mt-5"
  },
  variants: {
    mobilePanel: {
      true: {
        link: "min-h-11 grid-cols-[1.5rem_minmax(0,1fr)_auto] grid-rows-1 justify-items-stretch px-3 py-0 text-sm",
        label: "block"
      }
    }
  }
});

function NavigationIcon({ name }: Readonly<{ name: NavigationItem["icon"] }>) {
  const paths = {
    workspace: <><rect x="4" y="5" width="16" height="14" rx="2" /><path d="M4 9h16M8 5v4" /></>,
    notification: <><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9" /><path d="M10 21h4" /></>,
    account: <><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></>,
    admin: <><path d="M12 3 4.5 6v5.5c0 4.7 3.1 7.7 7.5 9.5 4.4-1.8 7.5-4.8 7.5-9.5V6Z" /><circle cx="12" cy="11" r="2.2" /><path d="M8.5 17a4 4 0 0 1 7 0" /></>
  } satisfies Record<NavigationItem["icon"], ReactNode>;

  return <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>;
}

function isCurrentRoute(pathname: string, item: NavigationItem): boolean {
  if (item.exact === true) return pathname === item.href;
  const prefixes = item.matchPrefixes ?? [item.href];
  return prefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

function userInitials(displayName: string): string {
  const characters = Array.from(displayName.trim());
  return characters.slice(0, 2).join("").toUpperCase() || "N";
}

function NavigationLink({ item, mobilePanel = false, pathname, unreadCount }: Readonly<{
  item: NavigationItem;
  mobilePanel?: boolean;
  pathname: string;
  unreadCount?: number;
}>) {
  const isCurrent = isCurrentRoute(pathname, item);
  const styles = navigationLinkStyles({ mobilePanel });

  return (
    <Link
      aria-current={isCurrent ? "page" : undefined}
      aria-label={item.label}
      data-admin-entry={item.icon === "admin" ? "true" : undefined}
      href={item.href}
      title={item.label}
      className={styles.link()}
    >
      <span className={styles.icon()}><NavigationIcon name={item.icon} /></span>
      <span className={styles.label()}>{item.label}</span>
      {unreadCount !== undefined && unreadCount > 0 ? (
        <span className={styles.badge()} aria-label={`읽지 않은 알림 ${unreadCount}개`}>
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
  unreadCount,
  workspaces
}: AuthenticatedNavigationProps) {
  const currentPathname = usePathname();
  const pathname = pathnameOverride ?? currentPathname;
  const pathScope = /^\/workspaces\/([^/]+)/u.exec(pathname)?.[1];
  const requestedScope = pathScope === undefined ? undefined : decodeURIComponent(pathScope);
  const activeWorkspace = workspaces.find((workspace) => workspace.storageScopeId === requestedScope);
  const activeScope = activeWorkspace?.storageScopeId;
  const workspaceBaseHref = activeScope === undefined
    ? "/workspaces"
    : `/workspaces/${encodeURIComponent(activeScope)}`;
  const workspaceNavigation: readonly NavigationItem[] = [
    { exact: true, href: "/workspaces", icon: "workspace", label: "워크스페이스" }
  ];
  const collaborationNavigation: readonly NavigationItem[] = [
    { href: "/notifications", icon: "notification", label: "알림", matchPrefixes: ["/notifications"] }
  ];
  const accountNavigation: readonly NavigationItem[] = [
    { href: "/account", icon: "account", label: "계정 설정", matchPrefixes: ["/account"] }
  ];
  const adminNavigation: NavigationItem = {
    href: "/admin",
    icon: "admin",
    label: "관리자 홈",
    matchPrefixes: ["/admin"]
  };
  const styles = navigationStyles();

  return (
    <aside className={styles.root()} data-slot="authenticated-navigation">
      <Link className={styles.brand()} href="/workspaces" aria-label="NURITEO 홈">
        <span className={styles.brandMark()} aria-hidden="true">N</span>
        <strong className={styles.brandLabel()}>NURITEO</strong>
      </Link>

      <Link className={styles.workspaceCard()} href={activeScope === undefined ? "/workspaces" : workspaceBaseHref}>
        <span className={styles.workspaceCopy()}><strong>{activeWorkspace?.displayLabel ?? "워크스페이스"}</strong><small>{activeWorkspace === undefined ? "작업 공간 선택" : `${workspaceOwnerLabel(activeWorkspace)} 워크스페이스`}</small></span>
        <b className={styles.workspaceArrow()} aria-hidden="true">→</b>
      </Link>

      <nav className={`${styles.nav()} ${styles.workspaceNav()}`} aria-label="현재 워크스페이스 메뉴">
        <p className={styles.label()}>탐색</p>
        {workspaceNavigation.map((item) => (
          <NavigationLink
            item={item}
            key={item.href}
            pathname={pathname}
          />
        ))}
      </nav>

      <nav className={`${styles.nav()} ${styles.collaborationNav()}`} aria-label="협업 메뉴">
        <p className={styles.label()}>협업</p>
        {collaborationNavigation.map((item) => (
          <NavigationLink
            item={item}
            key={item.href}
            pathname={pathname}
            {...(item.icon === "notification" ? { unreadCount } : {})}
          />
        ))}
      </nav>

      <nav className={`${styles.nav()} ${styles.accountNav()}`} aria-label="계정 메뉴">
        <p className={styles.label()}>계정 설정</p>
        {accountNavigation.map((item) => (
          <NavigationLink item={item} key={item.href} pathname={pathname} />
        ))}
        {isInstanceAdmin ? (
          <NavigationLink item={adminNavigation} pathname={pathname} />
        ) : null}
      </nav>

      <LogoutButton />

      <div className={styles.footer()}>
        <span className={styles.avatar()}>{userInitials(displayName)}</span>
        <span className={styles.user()}><strong>{displayName}</strong><small>{email}</small></span>
        <ThemeSelector className={styles.theme()} triggerClassName={styles.themeTrigger()} initialMode={themeMode} />
      </div>

      <CollapsibleRoot className={styles.mobileMore()}>
        <CollapsibleTrigger className={styles.mobileTrigger()} aria-label="계정 및 시스템 메뉴 열기">
          <span className={styles.mobileMoreIcon()} aria-hidden="true">•••</span>
          <span>더보기</span>
        </CollapsibleTrigger>
        <CollapsiblePanel><CollapsibleContent className={styles.mobilePanel()}>
          <header className={styles.mobileHeader()}>
            <span className={styles.avatar()}>{userInitials(displayName)}</span>
            <span className={styles.mobileUser()}><strong>{displayName}</strong><small>{email}</small></span>
            <ThemeSelector triggerClassName={styles.mobileThemeTrigger()} initialMode={themeMode} />
          </header>
          <nav className={styles.mobileNav()} aria-label="모바일 계정 메뉴">
            {collaborationNavigation.map((item) => (
              <NavigationLink
                item={item}
                key={item.href}
                mobilePanel
                pathname={pathname}
                {...(item.icon === "notification" ? { unreadCount } : {})}
              />
            ))}
            {accountNavigation.map((item) => (
              <NavigationLink item={item} key={item.href} mobilePanel pathname={pathname} />
            ))}
            {isInstanceAdmin ? <NavigationLink item={adminNavigation} mobilePanel pathname={pathname} /> : null}
          </nav>
          <LogoutButton placement="mobile" />
        </CollapsibleContent></CollapsiblePanel>
      </CollapsibleRoot>
    </aside>
  );
}
