import Link from "next/link";
import type { ReactNode } from "react";

import { ThemeSelector } from "#src/components/theme-selector.tsx";
import type { ThemeMode } from "#src/lib/theme.ts";
import { LogoutButton } from "#src/app/(authenticated)/logout-button.tsx";
import { AdminNavigation } from "#src/app/(admin)/admin/admin-navigation.tsx";

interface AdminShellFrameProps {
  readonly children: ReactNode;
  readonly displayName: string;
  readonly email: string;
  readonly pathnameOverride?: string | undefined;
  readonly themeMode: ThemeMode;
}

function userInitials(displayName: string): string {
  const characters = Array.from(displayName.trim());
  return characters.slice(0, 2).join("").toUpperCase() || "N";
}

function AdminIdentity({ displayName, email }: Readonly<{
  displayName: string;
  email: string;
}>) {
  return (
    <div className="admin-shell__identity">
      <span className="admin-shell__avatar">{userInitials(displayName)}</span>
      <span><strong>{displayName}</strong><small>{email}</small></span>
      <b>관리자</b>
    </div>
  );
}

export function AdminShellFrame({
  children,
  displayName,
  email,
  pathnameOverride,
  themeMode
}: AdminShellFrameProps) {
  return (
    <div className="admin-application-shell">
      <aside className="admin-sidebar">
        <Link className="admin-sidebar__brand" href="/admin" aria-label="NURITEO 관리자 홈">
          <span aria-hidden="true">N</span>
          <span><strong>NURITEO</strong><small>관리자 홈</small></span>
        </Link>

        <Link className="admin-sidebar__return" href="/workspaces">
          <span aria-hidden="true">←</span>
          사용자 화면으로 돌아가기
        </Link>

        <AdminNavigation pathnameOverride={pathnameOverride} />

        <div className="admin-sidebar__footer">
          <AdminIdentity displayName={displayName} email={email} />
          <div className="admin-sidebar__utilities">
            <ThemeSelector initialMode={themeMode} />
            <LogoutButton />
          </div>
        </div>
      </aside>

      <header className="admin-mobile-header">
        <Link className="admin-mobile-header__brand" href="/admin">
          <span aria-hidden="true">N</span>
          <strong>관리자 홈</strong>
        </Link>
        <details>
          <summary>관리 메뉴</summary>
          <div className="admin-mobile-header__panel">
            <AdminIdentity displayName={displayName} email={email} />
            <AdminNavigation pathnameOverride={pathnameOverride} />
            <Link className="admin-sidebar__return" href="/workspaces">사용자 화면으로 돌아가기</Link>
            <div className="admin-sidebar__utilities">
              <ThemeSelector initialMode={themeMode} />
              <LogoutButton />
            </div>
          </div>
        </details>
      </header>

      <div className="admin-shell">{children}</div>
    </div>
  );
}

export function AdminShellLoading() {
  return (
    <div className="admin-application-shell admin-application-shell--loading" aria-busy="true">
      <aside className="admin-sidebar" aria-hidden="true">
        <span className="admin-shell-loading__brand" />
        <span className="admin-shell-loading__return" />
        <span className="admin-shell-loading__navigation" />
      </aside>
      <main id="main-content" className="admin-shell workspace-page">
        <span className="sr-only" aria-live="polite">관리자 홈을 불러오는 중</span>
        <div className="loading-shell" aria-hidden="true">
          <span className="loading-shell__line loading-shell__line--short" />
          <span className="loading-shell__line loading-shell__line--title" />
          <div className="loading-shell__grid"><div /><div /><div /></div>
        </div>
      </main>
    </div>
  );
}
