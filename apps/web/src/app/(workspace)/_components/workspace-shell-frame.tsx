import type { Workspace } from "@nuriteo/api-client";
import Link from "next/link";
import type { ReactNode } from "react";
import { tv } from "tailwind-variants";

import { WorkspaceNavigation } from "@/app/(workspace)/_components/workspace-navigation.tsx";
import { LogoutButton } from "@/app/(authenticated)/_components/logout-button.tsx";
import { ThemeSelector } from "#src/components/theme-selector.tsx";
import { CollapsibleContent, CollapsiblePanel, CollapsibleRoot, CollapsibleTrigger } from "#src/components/ui/collapsible.tsx";
import { LoadingShell } from "#src/components/ui/loading-shell.tsx";
import type { ThemeMode } from "#src/lib/theme.ts";

const workspaceShellStyles = tv({
  slots: {
    root: "grid min-h-screen grid-cols-[15.5rem_minmax(0,1fr)] bg-sidebar max-[48rem]:block",
    sidebar: "sticky top-0 z-[var(--n-z-sticky)] flex h-screen min-w-0 flex-col bg-sidebar px-2 pb-2 pt-2 max-[48rem]:hidden",
    brand: "flex min-h-9 items-center gap-2 rounded-md px-2 text-foreground no-underline hover:bg-hover",
    brandMark: "grid size-6 place-items-center rounded-md bg-primary text-[0.6875rem] font-bold text-on-primary shadow-xs",
    brandCopy: "grid min-w-0 gap-0.5",
    brandTitle: "text-sm tracking-[0.08em]",
    brandSubtitle: "text-[var(--n-font-size-2xs)] text-subtle-foreground",
    returnLink: "mt-2 flex min-h-8 items-center gap-2 rounded-md px-2 text-xs font-medium text-subtle-foreground no-underline hover:bg-hover hover:text-foreground",
    workspaceCard: "mt-2 grid min-w-0 gap-0.5 rounded-md border border-muted-border/70 bg-[color-mix(in_srgb,var(--n-color-bg-surface)_38%,transparent)] px-2.5 py-2",
    workspaceLabel: "text-[var(--n-font-size-2xs)] font-semibold text-subtle-foreground",
    workspaceName: "truncate text-xs font-semibold text-foreground",
    workspaceType: "text-[var(--n-font-size-2xs)] text-subtle-foreground",
    footer: "mt-2 grid gap-2 border-t border-muted-border/70 pt-2",
    footerBody: "grid gap-2",
    identity: "grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-center gap-2 rounded-md px-1 py-1 text-foreground no-underline hover:bg-hover",
    avatar: "grid size-7 place-items-center rounded-md bg-selected text-[var(--n-font-size-2xs)] font-bold text-link",
    identityCopy: "grid min-w-0",
    identityName: "truncate text-xs text-foreground",
    identityEmail: "truncate text-[var(--n-font-size-2xs)] text-subtle-foreground",
    utilities: "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2",
    theme: "w-full min-w-0 max-w-none",
    themeTrigger: "w-full min-w-0 max-w-none",
    content: "my-2 mr-2 min-h-[calc(100vh-1rem)] min-w-0 overflow-hidden rounded-xl border border-muted-border bg-background shadow-xs max-[48rem]:m-0 max-[48rem]:min-h-[calc(100vh-3.25rem)] max-[48rem]:rounded-none max-[48rem]:border-0 max-[48rem]:shadow-none",
    maintenance: "mx-5 mt-4 flex items-center gap-3 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-xs",
    mobileHeader: "hidden max-[48rem]:sticky max-[48rem]:top-0 max-[48rem]:z-[var(--n-z-sticky)] max-[48rem]:flex max-[48rem]:min-h-[3.25rem] max-[48rem]:items-center max-[48rem]:justify-between max-[48rem]:border-b max-[48rem]:border-muted-border max-[48rem]:bg-sidebar/95 max-[48rem]:px-3 max-[48rem]:backdrop-blur-2xl",
    mobileBrand: "flex min-w-0 items-center gap-2 text-foreground no-underline",
    mobileWorkspace: "max-w-48 truncate text-sm font-semibold",
    mobileMenu: "relative border-0 bg-transparent",
    mobileTrigger: "min-h-8 w-auto rounded-md border border-muted-border px-2.5 py-1.5 text-xs font-semibold",
    mobilePanel: "fixed inset-x-0 top-[3.25rem] z-[var(--n-z-sticky)] flex h-[calc(100vh-3.25rem)] flex-col overflow-auto border-0 bg-sidebar px-3 py-3",
    mobileFooter: "mt-6 grid gap-3 border-t border-muted-border pt-4",
    mobileReturnLink: "mt-0",
    loadingBlock: "block rounded-md bg-subtle",
    loadingBrand: "h-9",
    loadingWorkspace: "mt-3 h-16",
    loadingNavigation: "mt-3 min-h-72"
  }
});

interface WorkspaceShellFrameProps {
  readonly children: ReactNode;
  readonly displayName: string;
  readonly email: string;
  readonly maintenanceReadOnly?: boolean | undefined;
  readonly themeMode: ThemeMode;
  readonly workspace: Workspace;
}

export function WorkspaceShellFrame({
  children,
  displayName,
  email,
  maintenanceReadOnly = false,
  themeMode,
  workspace
}: WorkspaceShellFrameProps) {
  const styles = workspaceShellStyles();
  const organization = workspace.ownerType === "organization";
  const workspaceId = workspace.storageScopeId;

  return (
    <div className={styles.root()} data-slot="workspace-shell">
      <aside className={styles.sidebar()}>
        <Link className={styles.brand()} href="/workspaces" aria-label="NURITEO 워크스페이스 목록">
          <span className={styles.brandMark()} aria-hidden="true">N</span>
          <span className={styles.brandCopy()}>
            <strong className={styles.brandTitle()}>NURITEO</strong>
            <small className={styles.brandSubtitle()}>워크스페이스</small>
          </span>
        </Link>
        <Link className={styles.returnLink()} href="/workspaces">
          <span aria-hidden="true">←</span>
          워크스페이스 목록
        </Link>
        <div className={styles.workspaceCard()}>
          <span className={styles.workspaceLabel()}>현재 워크스페이스</span>
          <strong className={styles.workspaceName()} title={workspace.displayLabel}>{workspace.displayLabel}</strong>
          <span className={styles.workspaceType()}>{organization ? "조직 워크스페이스" : "개인 워크스페이스"}</span>
        </div>
        <WorkspaceNavigation organization={organization} workspaceId={workspaceId} />
        <WorkspaceSidebarFooter
          displayName={displayName}
          email={email}
          themeMode={themeMode}
        />
      </aside>

      <header className={styles.mobileHeader()}>
        <Link className={styles.mobileBrand()} href="/workspaces">
          <span className={styles.brandMark()} aria-hidden="true">N</span>
          <strong className={styles.mobileWorkspace()}>{workspace.displayLabel}</strong>
        </Link>
        <CollapsibleRoot className={styles.mobileMenu()}>
          <CollapsibleTrigger className={styles.mobileTrigger()}>워크스페이스 메뉴</CollapsibleTrigger>
          <CollapsiblePanel>
            <CollapsibleContent className={styles.mobilePanel()}>
              <div className={styles.workspaceCard()}>
                <span className={styles.workspaceLabel()}>현재 워크스페이스</span>
                <strong className={styles.workspaceName()}>{workspace.displayLabel}</strong>
                <span className={styles.workspaceType()}>{organization ? "조직 워크스페이스" : "개인 워크스페이스"}</span>
              </div>
              <WorkspaceNavigation organization={organization} placement="mobile" workspaceId={workspaceId} />
              <div className={styles.mobileFooter()}>
                <Link className={styles.returnLink({ className: styles.mobileReturnLink() })} href="/workspaces">← 워크스페이스 목록</Link>
                <WorkspaceSidebarFooter
                  displayName={displayName}
                  email={email}
                  mobile
                  themeMode={themeMode}
                />
              </div>
            </CollapsibleContent>
          </CollapsiblePanel>
        </CollapsibleRoot>
      </header>

      <div className={styles.content()}>
        {maintenanceReadOnly ? (
          <aside className={styles.maintenance()} role="status">
            <strong>유지보수 모드</strong>
            <span>관리 작업이 끝날 때까지 프로젝트는 읽기 전용입니다.</span>
          </aside>
        ) : null}
        {children}
      </div>
    </div>
  );
}

function WorkspaceSidebarFooter({
  displayName,
  email,
  mobile = false,
  themeMode
}: Readonly<{
  displayName: string;
  email: string;
  mobile?: boolean;
  themeMode: ThemeMode;
}>) {
  const styles = workspaceShellStyles();

  return (
    <div className={mobile ? styles.footerBody() : styles.footer()}>
      <Link className={styles.identity()} href="/account">
        <span className={styles.avatar()}>{userInitials(displayName)}</span>
        <span className={styles.identityCopy()}>
          <strong className={styles.identityName()}>{displayName}</strong>
          <small className={styles.identityEmail()}>{email}</small>
        </span>
      </Link>
      <div className={styles.utilities()}>
        <ThemeSelector className={styles.theme()} triggerClassName={styles.themeTrigger()} initialMode={themeMode} />
        <LogoutButton placement={mobile ? "mobile" : "sidebar"} />
      </div>
    </div>
  );
}

function userInitials(displayName: string): string {
  return Array.from(displayName.trim()).slice(0, 2).join("").toUpperCase() || "N";
}

export function WorkspaceShellLoading() {
  const styles = workspaceShellStyles();

  return (
    <div className={styles.root()} aria-busy="true">
      <aside className={styles.sidebar()} aria-hidden="true">
        <span className={styles.loadingBlock({ className: styles.loadingBrand() })} />
        <span className={styles.loadingBlock({ className: styles.loadingWorkspace() })} />
        <span className={styles.loadingBlock({ className: styles.loadingNavigation() })} />
      </aside>
      <main className={styles.content()} id="main-content">
        <LoadingShell label="워크스페이스를 불러오는 중" />
      </main>
    </div>
  );
}
