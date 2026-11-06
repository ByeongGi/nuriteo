"use client";

import type { Project } from "@nuriteo/api-client";
import { tv } from "tailwind-variants";

import { Badge } from "@/components/ui/badge.tsx";
import { Button } from "@/components/ui/button.tsx";
import { ConfirmationDialog } from "@/components/ui/confirmation-dialog.tsx";
import { TextField } from "@/components/ui/field.tsx";
import { ScrollAreaContent, ScrollAreaRoot, ScrollAreaScrollbar, ScrollAreaThumb, ScrollAreaViewport } from "@/components/ui/scroll-area.tsx";
import { useProjectHistoryPanel } from "@/projects/_hooks/use-project-history-panel.ts";
import type { HistoryReference, ProjectHistoryState, RestoredProjectHead } from "@/projects/_hooks/use-project-history-panel.ts";
import { VERSION_PAGE_SIZE, formatBytes, formatTimestamp, sortRecoveryCheckpoints } from "@/projects/_utils/project-history.ts";

export { sortRecoveryCheckpoints };

export type { ProjectHistoryState, RestoredProjectHead };

const historyPanelStyles = tv({
  slots: {
    root: "grid gap-5 rounded-xl border border-muted-border bg-surface p-5 shadow-xs",
    header: "flex flex-wrap items-start justify-between gap-3 border-b border-muted-border pb-4",
    headerCopy: "grid min-w-0 gap-1 [&_p]:m-0",
    eyebrow: "text-xs font-semibold tracking-[.08em] text-accent-foreground",
    title: "m-0 text-base font-semibold",
    description: "max-w-2xl text-xs leading-relaxed text-muted-foreground",
    status: "m-0 rounded-md bg-subtle px-3 py-2 text-sm text-muted-foreground",
    feedback: "grid gap-2 rounded-md border p-3 [&_p]:m-0 [&_p]:text-sm",
    error: "border-danger/40 bg-danger-subtle text-danger",
    restored: "border-warning/40 bg-warning/10",
    createForm: "grid items-end gap-3 sm:grid-cols-[minmax(16rem,1fr)_auto]",
    columns: "grid min-w-0 gap-4 lg:grid-cols-2",
    listSection: "grid min-w-0 content-start gap-3 rounded-lg border border-muted-border bg-background p-3",
    listHeading: "flex items-center justify-between gap-3 [&_h4]:m-0 [&_h4]:text-sm [&_h4]:font-semibold",
    listEmpty: "m-0 grid min-h-28 place-items-center rounded-md bg-subtle px-4 text-center text-sm text-muted-foreground",
    scrollRoot: "max-h-[32rem] min-h-0",
    list: "m-0 grid list-none gap-2 p-0 pr-2",
    item: "rounded-md border border-muted-border bg-surface p-3 [content-visibility:auto] [contain-intrinsic-size:auto_5rem]",
    itemLayout: "flex items-start justify-between gap-3",
    itemCopy: "grid min-w-0 gap-1 [&_strong]:truncate [&_strong]:text-sm [&_p]:m-0 [&_p]:text-xs [&_p]:leading-relaxed [&_p]:text-muted-foreground",
    more: "w-full"
  },
  variants: {
    density: {
      comfortable: {},
      compact: {
        root: "gap-4 rounded-lg p-4 shadow-none",
        header: "pb-3",
        createForm: "gap-2",
        columns: "gap-3",
        listSection: "gap-2 p-3",
        item: "p-2.5"
      }
    }
  },
  defaultVariants: { density: "comfortable" }
});

interface Props {
  readonly density?: "comfortable" | "compact";
  readonly hasLocalDraft: boolean;
  readonly onProjectCommit: (result: { readonly projectEtag: string; readonly projectVersion: number }) => void;
  readonly onReloadProject: () => void;
  readonly onResumeRestoredSave: (head: RestoredProjectHead) => void;
  readonly initialState?: ProjectHistoryState | undefined;
  readonly project: Project;
  readonly projectEtag?: string;
}

export function ProjectHistoryPanel({
  density = "comfortable",
  hasLocalDraft,
  onProjectCommit,
  onReloadProject,
  onResumeRestoredSave,
  initialState,
  project,
  projectEtag
}: Props) {
  const {
    closeRestore,
    confirmRestore,
    createVersion,
    cursor,
    error,
    isLoading,
    isLoadingMore,
    isMutating,
    loadMore,
    openRestore,
    pendingRestore,
    recovery,
    restoredHead,
    stale,
    status,
    versions
  } = useProjectHistoryPanel({ initialState, onProjectCommit, project, projectEtag });
  const archived = project.state === "archived";
  const styles = historyPanelStyles({ density });
  return (
    <section className={styles.root()} aria-labelledby={`history-title-${project.id}`}>
      <header className={styles.header()}>
        <div className={styles.headerCopy()}>
          <p className={styles.eyebrow()}>서버 기록</p>
          <h3 id={`history-title-${project.id}`} className={styles.title()}>버전과 복구</h3>
          <p className={styles.description()}>복구는 서버 작업 버전만 변경합니다. 이 브라우저의 로컬 초안을 자동으로 덮어쓰지 않습니다.</p>
        </div>
        {archived ? <Badge size="sm" tone="neutral" variant="status">보관됨 · 읽기 전용</Badge> : null}
      </header>

      <p className={styles.status()} role="status" aria-live="polite">{status}</p>
      {error ? <div className={`${styles.feedback()} ${styles.error()}`} role="alert"><p>{error}</p>{(function () {
    if (stale) {
        return (<Button className="justify-self-start" type="button" size="sm" onClick={onReloadProject}>최신 프로젝트 다시 불러오기</Button>);
    }
    return (null);
})()}</div> : null}
      {restoredHead !== undefined ? (
        <div className={`${styles.feedback()} ${styles.restored()}`}>
          <p><strong>서버 v{restoredHead.projectVersion}을 복구했습니다.</strong> {(function () {
    if (hasLocalDraft) {
        return ("현재 로컬 초안은 열린 상태로 그대로 유지됩니다.");
    }
    return ("열린 로컬 초안이 없습니다.");
})()}</p>
          {(function () {
    if (!archived && hasLocalDraft) {
        return (<Button className="justify-self-start" type="button" size="sm" variant="primary" onClick={() => onResumeRestoredSave(restoredHead)}>로컬 초안을 복구한 서버 저장본으로 교체</Button>);
    }
    return (null);
})()}
        </div>
      ) : null}

      {!archived ? (
        <form className={styles.createForm()} onSubmit={createVersion} aria-busy={isMutating}>
          <TextField label="버전 이름" name="versionName" required maxLength={200} disabled={isMutating || projectEtag === undefined} />
          <Button type="submit" size="sm" disabled={isMutating || projectEtag === undefined}>{(function () {
    if (isMutating) {
        return ("처리 중…");
    }
    return ("버전 만들기");
})()}</Button>
        </form>
      ) : null}

      <div className={styles.columns()}>
        <HistoryList
          archived={archived}
          heading="버전"
          isLoading={isLoading}
          items={versions.map((version) => ({
            id: version.id,
            kind: "version" as const,
            label: version.name,
            createdAt: version.createdAt,
            detail: `서버 v${version.sourceProjectVersion} · ${formatBytes(version.physicalBytes)} · 파일 ${version.fileCount}개`
          }))}
          isMutating={isMutating}
          onRestore={openRestore}
        />
        <HistoryList
          archived={archived}
          heading="복구 지점"
          isLoading={isLoading}
          items={recovery.map((checkpoint) => ({
            id: checkpoint.id,
            kind: "recovery" as const,
            label: `복구 지점 ${checkpoint.position}`,
            createdAt: checkpoint.createdAt,
            detail: `${formatBytes(checkpoint.physicalBytes)} · 파일 ${checkpoint.fileCount}개`
          }))}
          isMutating={isMutating}
          onRestore={openRestore}
        />
      </div>
      {cursor !== null ? <Button className={styles.more()} type="button" size="sm" disabled={isLoadingMore} onClick={() => void loadMore()}>{(function () {
    if (isLoadingMore) {
        return ("불러오는 중…");
    }
    return (`버전 ${VERSION_PAGE_SIZE}개 더 보기`);
})()}</Button> : null}

      <ConfirmationDialog
        busy={isMutating}
        confirmLabel={isMutating ? "복구 중…" : "서버 작업 버전 복구"}
        description={pendingRestore === undefined ? "" : `선택한 ${formatTimestamp(pendingRestore.createdAt)} 스냅샷을 새로운 서버 작업 버전으로 지정합니다. ${(function () {
    if (hasLocalDraft) {
        return ("직접 교체하기 전까지 열린 로컬 초안은 그대로 유지됩니다.");
    }
    return ("브라우저가 로컬 초안을 자동으로 시작하거나 교체하지 않습니다.");
})()}`}
        open={pendingRestore !== undefined}
        title={pendingRestore === undefined ? "버전을 복구할까요?" : `${pendingRestore.label}을 복구할까요?`}
        tone="danger"
        onCancel={closeRestore}
        onConfirm={() => void confirmRestore()}
      />
    </section>
  );
}

interface HistoryListItem extends HistoryReference { readonly detail: string }

function HistoryList({ archived, heading, isLoading, isMutating, items, onRestore }: {
  readonly archived: boolean;
  readonly heading: string;
  readonly isLoading: boolean;
  readonly isMutating: boolean;
  readonly items: readonly HistoryListItem[];
  readonly onRestore: (item: HistoryReference, trigger: HTMLButtonElement) => void;
}) {
  const styles = historyPanelStyles();
  return (
    <section className={styles.listSection()} aria-label={heading}>
      <div className={styles.listHeading()}><h4>{heading}</h4><Badge size="sm" tone="neutral" variant="count">{items.length}개</Badge></div>
      {isLoading ? <p className={styles.listEmpty()}>불러오는 중…</p> : (function () {
    if (items.length === 0) {
        return (<p className={styles.listEmpty()}>아직 {heading}이 없습니다.</p>);
    }
    return ((
        <ScrollAreaRoot className={styles.scrollRoot()}>
          <ScrollAreaViewport>
            <ScrollAreaContent>
              <ol className={styles.list()}>
                {items.map((item) => <li className={styles.item()} key={item.id}><div className={styles.itemLayout()}><div className={styles.itemCopy()}><strong title={item.label}>{item.label}</strong><p>{formatTimestamp(item.createdAt)} · {item.detail}</p></div>{(function () {
    if (archived) {
        return (null);
    }
    return (<Button type="button" size="sm" disabled={isMutating} onClick={(event) => onRestore(item, event.currentTarget)}>복구</Button>);
})()}</div></li>)}
              </ol>
            </ScrollAreaContent>
          </ScrollAreaViewport>
          <ScrollAreaScrollbar><ScrollAreaThumb /></ScrollAreaScrollbar>
        </ScrollAreaRoot>
      ));
})()}
    </section>
  );
}
