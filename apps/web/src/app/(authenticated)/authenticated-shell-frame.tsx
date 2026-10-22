import type { ReactNode } from "react";

import type { ThemeMode } from "#src/lib/theme.ts";
import { AuthenticatedNavigation } from "#src/app/(authenticated)/authenticated-navigation.tsx";

interface AuthenticatedShellFrameProps {
  readonly children: ReactNode;
  readonly displayName: string;
  readonly email: string;
  readonly isInstanceAdmin: boolean;
  readonly maintenanceReadOnly?: boolean | undefined;
  readonly pathnameOverride?: string | undefined;
  readonly themeMode: ThemeMode;
  readonly unreadCount: number;
}

export function AuthenticatedShellFrame({
  children,
  displayName,
  email,
  isInstanceAdmin,
  maintenanceReadOnly = false,
  pathnameOverride,
  themeMode,
  unreadCount
}: AuthenticatedShellFrameProps) {
  return (
    <div className="authenticated-shell">
      <AuthenticatedNavigation
        displayName={displayName}
        email={email}
        isInstanceAdmin={isInstanceAdmin}
        pathnameOverride={pathnameOverride}
        themeMode={themeMode}
        unreadCount={unreadCount}
      />
      <div className="authenticated-shell__content" data-navigation-feature="Access tokens">
        {maintenanceReadOnly ? (
          <aside className="maintenance-banner" role="status">
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
  return (
    <div className="authenticated-shell authenticated-shell--loading" aria-busy="true">
      <aside className="authenticated-navigation authenticated-navigation--loading" aria-hidden="true">
        <span className="authenticated-shell-loading__brand" />
        <span className="authenticated-shell-loading__workspace" />
        <span className="authenticated-shell-loading__navigation" />
      </aside>
      <main className="authenticated-shell__content workspace-page" id="main-content">
        <span className="sr-only" aria-live="polite">워크스페이스를 불러오는 중</span>
        <div className="loading-shell" aria-hidden="true">
          <span className="loading-shell__line loading-shell__line--short" />
          <span className="loading-shell__line loading-shell__line--title" />
          <div className="loading-shell__grid"><div /><div /><div /></div>
        </div>
      </main>
    </div>
  );
}
