"use client";

import type { Workspace } from "@nuriteo/api-client";
import Link from "next/link";
import { tv } from "tailwind-variants";

import { useWorkspaceCatalog } from "@/app/(authenticated)/workspaces/_hooks/use-workspace-catalog.ts";
import { buttonVariants } from "@/components/ui/button.styles.ts";
import { PageHeader } from "@/components/ui/page-header.tsx";
import { SegmentedControl } from "@/components/ui/segmented-control.tsx";
import { SearchField } from "@/components/ui/search-field.tsx";
import { workspaceOwnerLabel } from "@/lib/workspace-selection.ts";

const workspaceScreenStyles = tv({
  slots: {
    root: "mx-auto w-full max-w-[68rem] px-6 py-8 outline-none max-[48rem]:px-4 max-[48rem]:py-5",
    actions: "flex flex-wrap items-center gap-2",
    status: "mt-4 rounded-md border border-muted-border bg-surface px-3 py-2 text-xs text-muted-foreground",
    body: "mt-7 grid gap-4",
    eyebrow: "m-0 text-xs font-semibold tracking-[0.08em] text-accent-foreground",
    toolbar: "flex items-center gap-2 max-[48rem]:items-stretch max-[48rem]:flex-col",
    search: "flex-1",
    collection: "grid gap-2",
    collectionHeader: "flex items-end justify-between gap-4 px-1 [&_h2]:m-0 [&_h2]:text-sm [&_h2]:font-semibold [&_p]:mt-1 [&_p]:mb-0 [&_p]:text-xs [&_p]:text-muted-foreground",
    collectionCount: "shrink-0 text-xs tabular-nums text-subtle-foreground",
    panel: "overflow-hidden rounded-lg border border-muted-border bg-surface",
    empty: "grid min-h-52 place-content-center justify-items-center gap-2 px-6 text-center text-muted-foreground [&_strong]:text-sm [&_strong]:text-foreground [&_span]:text-xs",
    list: "m-0 grid list-none p-0",
    row: "[content-visibility:auto] [contain-intrinsic-size:0_4.75rem] [&+&]:border-t [&+&]:border-muted-border",
    rowLink: "group grid min-h-[4.75rem] grid-cols-[2.25rem_minmax(0,1fr)_auto] items-center gap-3 px-4 py-3 text-foreground no-underline transition-colors hover:bg-hover focus-visible:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus max-[32rem]:grid-cols-[2.25rem_minmax(0,1fr)]",
    mark: "grid size-9 place-items-center rounded-lg border border-muted-border bg-subtle text-sm font-semibold text-primary transition-colors group-hover:border-primary/30 group-hover:bg-selected",
    rowCopy: "grid min-w-0 gap-1",
    rowTitle: "truncate text-sm font-semibold",
    rowMeta: "flex min-w-0 flex-wrap items-center gap-2 text-xs text-muted-foreground",
    type: "inline-flex items-center gap-1.5 rounded-full bg-subtle px-2 py-0.5",
    rowDescription: "truncate text-[var(--n-font-size-2xs)] text-subtle-foreground",
    arrow: "grid size-8 place-items-center rounded-md text-lg text-subtle-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-foreground max-[32rem]:col-start-2 max-[32rem]:row-start-2 max-[32rem]:hidden",
    emptyPage: "mx-auto mt-12 grid max-w-lg justify-items-start gap-3 rounded-lg border border-muted-border bg-surface p-6 [&_h1]:m-0 [&_h1]:text-xl [&_p]:m-0 [&_p]:text-sm [&_p]:text-muted-foreground",
    emptyActions: "flex flex-wrap gap-2 max-[48rem]:w-full max-[48rem]:flex-col"
  }
});

export function WorkspaceScreen({
  invitationStatus,
  workspaces
}: Readonly<{
  invitationStatus?: string | undefined;
  workspaces: readonly Workspace[];
}>) {
  const styles = workspaceScreenStyles();
  return (
    <main id="main-content" className={styles.root()} tabIndex={-1}>
      <PageHeader
        density="compact"
        eyebrow="작업 공간"
        title="워크스페이스"
        description="프로젝트와 구성원이 속한 워크스페이스를 선택하세요."
        actions={<div className={styles.actions()}>
          <Link className={buttonVariants({ size: "sm", variant: "primary" })} href="/workspaces/new/organization"><span aria-hidden="true">＋</span> 공유 워크스페이스 만들기</Link>
        </div>}
      />

      {invitationStatus ? (
        <p className={styles.status()} role="status" aria-live="polite">
          {invitationStatus}
        </p>
      ) : null}

      <WorkspaceCatalog workspaces={workspaces} />
    </main>
  );
}

export function EmptyWorkspaceScreen() {
  const styles = workspaceScreenStyles();
  return (
    <main id="main-content" className={styles.root()} tabIndex={-1}>
      <section className={styles.emptyPage()} aria-labelledby="workspace-empty-title">
        <p className={styles.eyebrow()}>시작할 작업 공간이 없습니다</p>
        <h1 id="workspace-empty-title">첫 워크스페이스를 준비하세요</h1>
        <p>개인 워크스페이스는 계정과 함께 준비됩니다. 공유 공간이 필요하면 새 워크스페이스를 추가하세요.</p>
        <div className={styles.emptyActions()}>
          <Link className={buttonVariants({ size: "sm", variant: "primary" })} href="/workspaces/new/organization">공유 워크스페이스 만들기</Link>
          <Link className={buttonVariants({ size: "sm", variant: "secondary" })} href="/workspaces">접근 권한 다시 확인</Link>
        </div>
      </section>
    </main>
  );
}

export function WorkspaceCatalog({ workspaces }: Readonly<{
  workspaces: readonly Workspace[];
}>) {
  const styles = workspaceScreenStyles();
  const {
    catalog,
    filter,
    isFiltering,
    query,
    setFilter,
    setQuery,
    showFilters
  } = useWorkspaceCatalog(workspaces);

  return (
    <div className={styles.body()}>
      {showFilters ? <section className={styles.toolbar()} aria-label="워크스페이스 검색 및 필터">
        <SearchField density="compact" className={styles.search()} label="워크스페이스 검색" value={query} onChange={(event) => setQuery(event.currentTarget.value)} placeholder="이름으로 검색" />
        <SegmentedControl
          aria-label="워크스페이스 유형"
          value={filter}
          onValueChange={setFilter}
          options={[
            { value: "all", label: `전체 ${workspaces.length}` },
            { value: "user", label: `개인 ${catalog.personalCount}` },
            { value: "organization", label: `조직 ${catalog.organizationCount}` }
          ]}
        />
      </section> : null}

      <section className={styles.collection()} aria-labelledby="workspace-list-title" aria-busy={isFiltering}>
        <header className={styles.collectionHeader()}>
          <div><h2 id="workspace-list-title">내 워크스페이스</h2><p>워크스페이스를 선택하면 프로젝트 목록으로 이동합니다.</p></div>
          <span className={styles.collectionCount()}>{catalog.filteredWorkspaces.length}개</span>
        </header>
        <div className={styles.panel()}>
          {catalog.filteredWorkspaces.length === 0 ? (
            <div className={styles.empty()}><strong>일치하는 워크스페이스가 없습니다.</strong><span>검색어를 지우거나 다른 유형을 선택해보세요.</span></div>
          ) : (
            <ul className={styles.list()}>
              {catalog.filteredWorkspaces.map((workspace) => (
                <li className={styles.row()} key={workspace.storageScopeId}>
                  <Link
                    aria-label={`${workspace.displayLabel} 워크스페이스 열기`}
                    className={styles.rowLink()}
                    href={`/workspaces/${encodeURIComponent(workspace.storageScopeId)}`}
                  >
                    <WorkspaceMark ownerType={workspace.ownerType} className={styles.mark()} />
                    <span className={styles.rowCopy()}>
                      <strong className={styles.rowTitle()}>{workspace.displayLabel}</strong>
                      <span className={styles.rowMeta()}>
                        <span className={styles.type()}>{workspaceOwnerLabel(workspace)} 워크스페이스</span>
                        <span className={styles.rowDescription()}>{(function () {
    if (workspace.ownerType === "user") {
        return ("개인 작업 공간");
    }
    return ("팀과 공유하는 작업 공간");
})()}</span>
                      </span>
                    </span>
                    <span className={styles.arrow()} aria-hidden="true">›</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </div>
  );
}

function WorkspaceMark({ className, ownerType }: Readonly<{
  className: string;
  ownerType: Workspace["ownerType"];
}>) {
  return (
    <span className={className} aria-hidden="true">
      <svg className="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
        {ownerType === "user" ? (
          <><circle cx="12" cy="8" r="3" /><path d="M5.5 20a6.5 6.5 0 0 1 13 0" /></>
        ) : (
          <><rect x="4" y="4" width="16" height="16" rx="2" /><path d="M8 8h2M14 8h2M8 12h2M14 12h2M10 20v-4h4v4" /></>
        )}
      </svg>
    </span>
  );
}
