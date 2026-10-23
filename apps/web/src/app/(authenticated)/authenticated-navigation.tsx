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
  readonly icon: "dashboard" | "workspace" | "project" | "notification" | "account" | "admin";
  readonly label: string;
  readonly matchPrefixes?: readonly string[];
}

const navigationStyles = tv({
  slots: {
    root: "sticky top-0 z-[var(--n-z-sticky)] flex h-screen flex-col border-r border-muted-border bg-sidebar p-4 shadow-[1px_0_0_color-mix(in_srgb,var(--n-color-bg-raised)_54%,transparent)] max-[64rem]:p-3 max-[48rem]:fixed max-[48rem]:inset-x-0 max-[48rem]:top-auto max-[48rem]:bottom-0 max-[48rem]:grid max-[48rem]:h-16 max-[48rem]:grid-cols-[minmax(0,1fr)_3.75rem] max-[48rem]:gap-1 max-[48rem]:border-r-0 max-[48rem]:border-t max-[48rem]:px-3 max-[48rem]:py-1",
    brand: "flex min-h-9 items-center gap-2 text-sm font-semibold tracking-[0.12em] text-foreground no-underline max-[64rem]:justify-center max-[48rem]:hidden",
    brandMark: "grid size-8 place-items-center rounded-[0.625rem] bg-primary font-semibold tracking-normal text-on-primary shadow-[0_0.375rem_1rem_color-mix(in_srgb,var(--n-color-action-primary)_24%,transparent)]",
    brandLabel: "max-[64rem]:hidden",
    workspaceCard: "mt-6 flex min-h-[3.25rem] items-center justify-between gap-2 rounded-md border border-muted-border bg-surface p-2 no-underline shadow-xs hover:border-strong-border hover:bg-hover max-[64rem]:justify-center max-[48rem]:hidden",
    workspaceCopy: "grid min-w-0 [&_small]:truncate [&_small]:text-xs [&_small]:text-subtle-foreground max-[64rem]:hidden",
    workspaceArrow: "max-[64rem]:hidden",
    nav: "mt-6 grid gap-1",
    workspaceNav: "max-[48rem]:m-0 max-[48rem]:grid max-[48rem]:h-full max-[48rem]:grid-cols-3 max-[48rem]:gap-1",
    collaborationNav: "max-[48rem]:hidden",
    accountNav: "mt-5 max-[48rem]:hidden",
    label: "mb-2 px-2 text-[0.6875rem] font-semibold uppercase tracking-[0.12em] text-subtle-foreground max-[64rem]:hidden",
    footer: "mt-3 grid grid-cols-[2rem_minmax(0,1fr)] items-center gap-2 border-t border-muted-border pt-3 max-[64rem]:grid-cols-1 max-[64rem]:justify-items-center max-[48rem]:hidden",
    avatar: "grid size-8 place-items-center rounded-full bg-raised text-xs font-semibold",
    user: "grid min-w-0 [&_small]:truncate [&_small]:text-xs [&_small]:text-subtle-foreground max-[64rem]:hidden",
    theme: "col-span-full w-full max-[64rem]:hidden",
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
    link: "relative grid min-h-[2.625rem] grid-cols-[1.5rem_minmax(0,1fr)_auto] items-center gap-2 rounded-md px-3 font-medium text-muted-foreground no-underline transition-colors hover:bg-hover hover:text-foreground aria-[current=page]:bg-selected aria-[current=page]:text-foreground aria-[current=page]:shadow-[inset_2px_0_var(--n-color-action-primary)] max-[64rem]:grid-cols-1 max-[64rem]:justify-items-center max-[64rem]:px-0 max-[48rem]:min-h-0 max-[48rem]:h-full max-[48rem]:grid-rows-[1.25rem_auto] max-[48rem]:content-center max-[48rem]:gap-0.5 max-[48rem]:py-1 max-[48rem]:text-[0.6875rem]",
    icon: "grid size-5 place-items-center [&_svg]:size-[1.125rem]",
    label: "min-w-0 truncate max-[64rem]:hidden max-[48rem]:block max-[48rem]:max-w-full",
    badge: "grid h-5 min-w-5 place-items-center rounded-full bg-primary px-1 text-[0.6875rem] text-on-primary max-[64rem]:absolute max-[64rem]:ml-6 max-[64rem]:-mt-6"
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
    dashboard: <><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></>,
    workspace: <><rect x="4" y="5" width="16" height="14" rx="2" /><path d="M4 9h16M8 5v4" /></>,
    project: <><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h3l2 2H18a2 2 0 0 1 2 2v11a3 3 0 0 1-3 3H6a2 2 0 0 1-2-2Z" /><path d="M4 8h16" /></>,
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
  const projectsHref = activeScope === undefined
    ? "/workspaces"
    : `${workspaceBaseHref}/projects`;
  const workspaceNavigation: readonly NavigationItem[] = [
    { exact: true, href: "/dashboard", icon: "dashboard", label: "대시보드" },
    { exact: true, href: "/workspaces", icon: "workspace", label: "워크스페이스" },
    ...(activeScope === undefined ? [] : [{ exact: true, href: projectsHref, icon: "project" as const, label: "프로젝트" }])
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
      <Link className={styles.brand()} href="/dashboard" aria-label="NURITEO 홈">
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
