import type { Workspace } from "@nuriteo/api-client";
import type { ReactNode } from "react";
import { tv } from "tailwind-variants";

import { AuthenticatedNavigation } from "#src/app/(authenticated)/authenticated-navigation.tsx";
import { LoadingShell } from "#src/components/ui/loading-shell.tsx";
import type { ThemeMode } from "#src/lib/theme.ts";

const authenticatedShellStyles = tv({
  slots: {
    root: "grid min-h-screen grid-cols-[15rem_minmax(0,1fr)] bg-[radial-gradient(circle_at_88%_0%,color-mix(in_srgb,var(--n-color-action-primary)_5%,transparent),transparent_28rem),var(--n-color-bg-page)] max-[64rem]:grid-cols-[4.75rem_minmax(0,1fr)] max-[48rem]:block max-[48rem]:pb-16",
    content: "min-h-screen min-w-0",
    maintenance: "mx-6 mt-4 flex w-auto items-center gap-3 rounded-lg border border-warning/30 bg-warning/10 px-4 py-3 text-sm max-[48rem]:mx-4",
    loadingNavigation: "sticky top-0 flex h-screen flex-col gap-5 border-r border-muted-border bg-sidebar p-4 max-[48rem]:hidden",
    loadingBrand: "h-9 animate-pulse rounded-md bg-raised",
    loadingWorkspace: "h-[3.25rem] animate-pulse rounded-md bg-raised",
    loadingNav: "min-h-96 animate-pulse rounded-md bg-raised",
    loadingMain: "w-full max-w-[82rem] px-[clamp(1.25rem,4vw,3.5rem)] pt-[clamp(2rem,4vw,3.75rem)] pb-20 max-[48rem]:px-4 max-[48rem]:py-5"
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
