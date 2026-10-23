import Link from "next/link";
import type { ReactNode } from "react";
import { tv } from "tailwind-variants";

import { ThemeSelector } from "#src/components/theme-selector.tsx";
import { CollapsibleContent, CollapsiblePanel, CollapsibleRoot, CollapsibleTrigger } from "#src/components/ui/collapsible.tsx";
import { LoadingShell } from "#src/components/ui/loading-shell.tsx";
import type { ThemeMode } from "#src/lib/theme.ts";
import { LogoutButton } from "#src/app/(authenticated)/logout-button.tsx";
import { AdminNavigation } from "#src/app/(admin)/admin/admin-navigation.tsx";

const adminShellStyles = tv({
  slots: {
    root: "grid min-h-screen grid-cols-[15.5rem_minmax(0,1fr)] bg-sidebar max-[48rem]:block",
    sidebar: "sticky top-0 z-[var(--n-z-sticky)] flex h-screen min-w-0 flex-col px-2 pb-3 pt-3 max-[48rem]:hidden",
    brand: "flex min-h-9 items-center gap-2.5 rounded-md px-2 text-foreground no-underline hover:bg-hover",
    brandMark: "grid size-7 place-items-center rounded-md bg-primary text-xs font-bold text-on-primary",
    brandCopy: "grid gap-0.5",
    brandTitle: "text-xs tracking-[0.08em]",
    brandSubtitle: "text-xs text-subtle-foreground",
    returnLink: "mt-2 flex min-h-8 items-center gap-2 rounded-md px-2 text-xs font-medium text-muted-foreground no-underline hover:bg-hover hover:text-foreground",
    footer: "mt-2 grid gap-2 border-t border-muted-border px-1 pt-3",
    identity: "grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2",
    avatar: "grid size-8 place-items-center rounded-full bg-selected text-xs font-bold text-link",
    identityCopy: "grid min-w-0",
    identityName: "truncate text-xs",
    identityEmail: "truncate text-[var(--n-font-size-2xs)] text-subtle-foreground",
    identityBadge: "rounded-full bg-selected px-[0.45rem] py-[0.2rem] text-[var(--n-font-size-2xs)] text-link",
    utilities: "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2",
    theme: "w-full min-w-0 max-w-none",
    themeTrigger: "w-full min-w-0 max-w-none",
    mobileHeader: "hidden max-[48rem]:sticky max-[48rem]:top-0 max-[48rem]:z-[var(--n-z-sticky)] max-[48rem]:flex max-[48rem]:min-h-[3.25rem] max-[48rem]:items-center max-[48rem]:justify-between max-[48rem]:border-b max-[48rem]:border-muted-border max-[48rem]:bg-[color-mix(in_srgb,var(--n-color-bg-surface)_94%,transparent)] max-[48rem]:px-3 max-[48rem]:backdrop-blur-2xl",
    mobileMenu: "relative border-0 bg-transparent",
    mobileTrigger: "min-h-8 w-auto rounded-md border border-muted-border px-2.5 py-1.5 text-xs font-semibold",
    mobilePanel: "fixed inset-x-0 top-[3.25rem] z-[var(--n-z-sticky)] flex h-[calc(100vh-3.25rem)] flex-col overflow-auto border-0 bg-surface px-3 py-4",
    mobileReturnLink: "mt-6",
    mobileUtilities: "mt-4 border-t border-muted-border pt-4",
    content: "my-2 mr-2 min-w-0 overflow-hidden rounded-xl border border-muted-border bg-background shadow-xs max-[48rem]:m-0 max-[48rem]:min-h-[calc(100vh-3.25rem)] max-[48rem]:rounded-none max-[48rem]:border-0 max-[48rem]:shadow-none",
    loadingBlock: "block rounded-md bg-subtle",
    loadingBrand: "h-10",
    loadingReturn: "mt-5 h-10",
    loadingNavigation: "mt-5 min-h-96"
  }
});

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
  const styles = adminShellStyles();

  return (
    <div className={styles.identity()}>
      <span className={styles.avatar()}>{userInitials(displayName)}</span>
      <span className={styles.identityCopy()}>
        <strong className={styles.identityName()}>{displayName}</strong>
        <small className={styles.identityEmail()}>{email}</small>
      </span>
      <b className={styles.identityBadge()}>관리자</b>
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
  const styles = adminShellStyles();

  return (
    <div className={styles.root()}>
      <aside className={styles.sidebar()}>
        <Link className={styles.brand()} href="/admin" aria-label="NURITEO 관리자 홈">
          <span className={styles.brandMark()} aria-hidden="true">N</span>
          <span className={styles.brandCopy()}>
            <strong className={styles.brandTitle()}>NURITEO</strong>
            <small className={styles.brandSubtitle()}>관리자 홈</small>
          </span>
        </Link>

        <Link className={styles.returnLink()} href="/workspaces">
          <span aria-hidden="true">←</span>
          사용자 화면으로 돌아가기
        </Link>

        <AdminNavigation pathnameOverride={pathnameOverride} />

        <div className={styles.footer()}>
          <AdminIdentity displayName={displayName} email={email} />
          <div className={styles.utilities()}>
            <ThemeSelector className={styles.theme()} triggerClassName={styles.themeTrigger()} initialMode={themeMode} />
            <LogoutButton />
          </div>
        </div>
      </aside>

      <header className={styles.mobileHeader()}>
        <Link className={styles.brand()} href="/admin">
          <span className={styles.brandMark()} aria-hidden="true">N</span>
          <strong>관리자 홈</strong>
        </Link>
        <CollapsibleRoot className={styles.mobileMenu()}>
          <CollapsibleTrigger className={styles.mobileTrigger()}>관리 메뉴</CollapsibleTrigger>
          <CollapsiblePanel><CollapsibleContent className={styles.mobilePanel()}>
            <AdminIdentity displayName={displayName} email={email} />
            <AdminNavigation placement="mobile" pathnameOverride={pathnameOverride} />
            <Link className={styles.returnLink({ className: styles.mobileReturnLink() })} href="/workspaces">사용자 화면으로 돌아가기</Link>
            <div className={styles.utilities({ className: styles.mobileUtilities() })}>
              <ThemeSelector className={styles.theme()} triggerClassName={styles.themeTrigger()} initialMode={themeMode} />
              <LogoutButton placement="mobile" />
            </div>
          </CollapsibleContent></CollapsiblePanel>
        </CollapsibleRoot>
      </header>

      <div className={styles.content()}>{children}</div>
    </div>
  );
}

export function AdminShellLoading() {
  const styles = adminShellStyles();

  return (
    <div className={styles.root()} aria-busy="true">
      <aside className={styles.sidebar()} aria-hidden="true">
        <span className={styles.loadingBlock({ className: styles.loadingBrand() })} />
        <span className={styles.loadingBlock({ className: styles.loadingReturn() })} />
        <span className={styles.loadingBlock({ className: styles.loadingNavigation() })} />
      </aside>
      <main id="main-content" className={styles.content()}>
        <LoadingShell label="관리자 홈을 불러오는 중" />
      </main>
    </div>
  );
}

export { adminShellStyles };
