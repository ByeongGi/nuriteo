"use client";

import type { Workspace } from "@nuriteo/api-client";
import Link from "next/link";
import { useMemo, useState } from "react";
import { tv } from "tailwind-variants";

import { PageHeader } from "#src/components/ui/page-header.tsx";
import { SegmentedControl } from "#src/components/ui/segmented-control.tsx";
import { SearchField } from "#src/components/ui/search-field.tsx";
import { workspaceOwnerLabel } from "#src/lib/workspace-selection.ts";

type WorkspaceFilter = "all" | Workspace["ownerType"];

const workspaceScreenStyles = tv({
  slots: {
    root: "w-full px-6 py-5 outline-none max-[48rem]:px-4 max-[48rem]:py-4",
    actions: "flex flex-wrap items-center gap-2",
    primaryAction: "inline-flex min-h-8 items-center justify-center rounded-md border border-primary bg-primary px-3 text-xs font-semibold text-on-primary no-underline shadow-xs hover:bg-primary-strong",
    secondaryAction: "inline-flex min-h-8 items-center justify-center rounded-md border border-strong-border bg-surface px-3 text-xs font-semibold text-foreground no-underline hover:bg-hover",
    status: "mt-4 rounded-md border border-muted-border bg-surface px-3 py-2 text-xs text-muted-foreground",
    body: "mt-5 grid gap-3",
    eyebrow: "m-0 text-xs font-semibold tracking-[0.08em] text-accent-foreground",
    toolbar: "flex items-center gap-2 border-b border-muted-border pb-3 max-[48rem]:items-stretch max-[48rem]:flex-col",
    search: "flex-1",
    panel: "overflow-hidden rounded-lg border border-muted-border bg-surface",
    panelHeader: "flex items-start justify-between gap-4 border-b border-muted-border px-4 py-3 [&_h2]:m-0 [&_h2]:text-sm [&_p]:mt-0.5 [&_p]:mb-0 [&_p]:text-xs [&_p]:text-muted-foreground",
    panelCount: "shrink-0 rounded-full bg-subtle px-2 py-1 text-xs whitespace-nowrap text-muted-foreground",
    empty: "grid min-h-48 place-content-center justify-items-center gap-2 text-muted-foreground [&_span]:text-sm",
    row: "grid min-h-14 grid-cols-[minmax(0,1fr)_auto] items-center gap-4 px-4 py-2.5 hover:bg-hover [&+&]:border-t [&+&]:border-muted-border",
    rowCopy: "grid min-w-0 gap-1 [&_strong]:truncate [&_span]:truncate [&_span]:text-xs [&_span]:text-muted-foreground",
    rowAction: "inline-flex min-h-8 items-center justify-center rounded-md border border-strong-border px-3 text-xs font-semibold text-foreground no-underline hover:bg-active max-[32rem]:col-span-full",
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
        eyebrow="개발 환경"
        title="워크스페이스"
        description="작업 공간을 선택해 프로젝트, 구성원과 설정을 관리합니다."
        actions={<div className={styles.actions()}>
          <Link className={styles.primaryAction()} href="/workspaces/new">워크스페이스 추가</Link>
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
          <Link className={styles.primaryAction()} href="/workspaces/new">워크스페이스 추가</Link>
          <Link className={styles.secondaryAction()} href="/workspaces">접근 권한 다시 확인</Link>
        </div>
      </section>
    </main>
  );
}

export function WorkspaceCatalog({ workspaces }: Readonly<{
  workspaces: readonly Workspace[];
}>) {
  const styles = workspaceScreenStyles();
  const [filter, setFilter] = useState<WorkspaceFilter>("all");
  const [query, setQuery] = useState("");
  const normalizedQuery = query.trim().toLocaleLowerCase("ko-KR");
  const filteredWorkspaces = useMemo(() => workspaces.filter((workspace) => (
    (filter === "all" || workspace.ownerType === filter)
    && (normalizedQuery === "" || workspace.displayLabel.toLocaleLowerCase("ko-KR").includes(normalizedQuery))
  )), [filter, normalizedQuery, workspaces]);
  const personalCount = workspaces.filter((workspace) => workspace.ownerType === "user").length;
  const organizationCount = workspaces.length - personalCount;

  return (
    <div className={styles.body()}>
      <section className={styles.toolbar()} aria-label="워크스페이스 검색 및 필터">
        <SearchField density="compact" className={styles.search()} label="워크스페이스 검색" value={query} onChange={(event) => setQuery(event.currentTarget.value)} placeholder="이름으로 검색" />
        <SegmentedControl
          aria-label="워크스페이스 유형"
          value={filter}
          onValueChange={setFilter}
          options={[
            { value: "all", label: `전체 ${workspaces.length}` },
            { value: "user", label: `개인 ${personalCount}` },
            { value: "organization", label: `조직 ${organizationCount}` }
          ]}
        />
      </section>

      <section className={styles.panel()} aria-labelledby="workspace-list-title">
        <header className={styles.panelHeader()}><div><h2 id="workspace-list-title">워크스페이스 목록</h2><p>접근 가능한 작업 공간을 선택하세요.</p></div><span className={styles.panelCount()}>{filteredWorkspaces.length}개</span></header>
        {filteredWorkspaces.length === 0 ? (
          <div className={styles.empty()}><strong>검색 결과가 없습니다.</strong><span>다른 이름이나 유형을 선택해보세요.</span></div>
        ) : (
          <div>
            {filteredWorkspaces.map((workspace) => {
              return (
                <article className={styles.row()} key={workspace.storageScopeId}>
                  <div className={styles.rowCopy()}><strong>{workspace.displayLabel}</strong><span>{workspaceOwnerLabel(workspace)} 워크스페이스</span></div>
                  <Link
                    className={styles.rowAction()}
                    href={`/workspaces/${encodeURIComponent(workspace.storageScopeId)}`}
                  >
                    워크스페이스 열기
                  </Link>
                </article>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
