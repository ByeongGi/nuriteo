import type { Workspace } from "@nuriteo/api-client";
import type { ReactNode } from "react";
import { tv } from "tailwind-variants";

import { AuthenticatedNavigation } from "@/app/(authenticated)/_components/authenticated-navigation.tsx";
import { LoadingShell } from "#src/components/ui/loading-shell.tsx";
import type { ThemeMode } from "#src/lib/theme.ts";

const authenticatedShellStyles = tv({
  slots: {
    root: "grid min-h-screen grid-cols-[15.5rem_minmax(0,1fr)] bg-sidebar max-[48rem]:block max-[48rem]:pb-16",
    content: "my-2 mr-2 min-h-[calc(100vh-1rem)] min-w-0 overflow-hidden rounded-xl border border-muted-border bg-background shadow-xs max-[48rem]:m-0 max-[48rem]:min-h-screen max-[48rem]:rounded-none max-[48rem]:border-0 max-[48rem]:shadow-none",
    maintenance: "mx-5 mt-4 flex w-auto items-center gap-3 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-xs max-[48rem]:mx-4",
    loadingNavigation: "sticky top-0 flex h-screen flex-col gap-3 bg-sidebar p-2 max-[48rem]:hidden",
    loadingBrand: "h-9 animate-pulse rounded-md bg-raised",
    loadingWorkspace: "h-12 animate-pulse rounded-md bg-raised",
    loadingNav: "min-h-72 animate-pulse rounded-md bg-raised",
    loadingMain: "w-full max-w-none px-6 py-6 max-[48rem]:px-4 max-[48rem]:py-4"
  }
});

interface AuthenticatedShellFrameProps {
  readonly children: ReactNode;
  readonly displayName: string;
  readonly email: string;
  readonly isInstanceAdmin: boolean;
  readonly maintenanceReadOnly?: boolean | undefined;
  readonly pathnameOverride?: string | undefined;
  readonly themeMode: ThemeMode;
  readonly unreadCount: number;
  readonly workspaces: readonly Workspace[];
}

export function AuthenticatedShellFrame({
  children,
  displayName,
  email,
  isInstanceAdmin,
  maintenanceReadOnly = false,
  pathnameOverride,
  themeMode,
  unreadCount,
  workspaces
}: AuthenticatedShellFrameProps) {
  const styles = authenticatedShellStyles();

  return (
    <div className={styles.root()} data-slot="authenticated-shell">
      <AuthenticatedNavigation
        displayName={displayName}
        email={email}
        isInstanceAdmin={isInstanceAdmin}
        pathnameOverride={pathnameOverride}
        themeMode={themeMode}
        unreadCount={unreadCount}
        workspaces={workspaces}
      />
      <div className={styles.content()} data-navigation-feature="Workspace and account">
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

export function AuthenticatedShellLoading() {
  const styles = authenticatedShellStyles();

  return (
    <div className={styles.root()} aria-busy="true">
      <aside className={styles.loadingNavigation()} aria-hidden="true">
        <span className={styles.loadingBrand()} />
        <span className={styles.loadingWorkspace()} />
        <span className={styles.loadingNav()} />
      </aside>
      <main className={`${styles.content()} ${styles.loadingMain()}`} id="main-content">
        <LoadingShell label="워크스페이스를 불러오는 중" />
      </main>
    </div>
  );
}
