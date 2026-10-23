"use client";

import {
  ApiError,
  ApiInvalidResponseError,
  ApiResponseTooLargeError,
  ApiTimeoutError,
  ApiTransportError,
  createProjectVersion,
  listProjectVersions,
  listRecoveryCheckpoints,
  reconcileProjectHistory,
  restoreProjectHistory
} from "@nuriteo/api-client";
import type {
  HistoricalReferenceKind,
  Project,
  ProjectVersion,
  RecoveryCheckpoint
} from "@nuriteo/api-client";
import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { tv } from "tailwind-variants";

import { Badge } from "#src/components/ui/badge.tsx";
import { Button } from "#src/components/ui/button.tsx";
import { ConfirmationDialog } from "#src/components/ui/confirmation-dialog.tsx";
import { TextField } from "#src/components/ui/field.tsx";
import { ScrollAreaContent, ScrollAreaRoot, ScrollAreaScrollbar, ScrollAreaThumb, ScrollAreaViewport } from "#src/components/ui/scroll-area.tsx";
import { createBrowserApiClient } from "#src/lib/api/browser-client.ts";
import { readCsrfCredential } from "#src/lib/api/browser-security.ts";

const VERSION_PAGE_SIZE = 20;
const timestampFormatter = new Intl.DateTimeFormat("ko-KR", {
  dateStyle: "medium",
  timeStyle: "short"
});

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
  }
});

interface HistoryReference {
  readonly id: string;
  readonly kind: HistoricalReferenceKind;
  readonly label: string;
  readonly createdAt: string;
}

export interface RestoredProjectHead {
  readonly projectEtag: string;
  readonly projectVersion: number;
}

export interface ProjectHistoryState {
  readonly nextCursor: string | null;
  readonly recovery: readonly RecoveryCheckpoint[];
  readonly versions: readonly ProjectVersion[];
}

interface Props {
  readonly hasLocalDraft: boolean;
  readonly onProjectCommit: (result: { readonly projectEtag: string; readonly projectVersion: number }) => void;
  readonly onReloadProject: () => void;
  readonly onResumeRestoredSave: (head: RestoredProjectHead) => void;
  readonly initialState?: ProjectHistoryState | undefined;
  readonly project: Project;
  readonly projectEtag?: string;
}

export function ProjectHistoryPanel({
  hasLocalDraft,
  onProjectCommit,
  onReloadProject,
  onResumeRestoredSave,
  initialState,
  project,
  projectEtag
}: Props) {
  const [versions, setVersions] = useState<readonly ProjectVersion[]>(initialState?.versions ?? []);
  const [recovery, setRecovery] = useState<readonly RecoveryCheckpoint[]>(initialState?.recovery ?? []);
  const [cursor, setCursor] = useState<string | null>(initialState?.nextCursor ?? null);
  const [isLoading, setIsLoading] = useState(initialState === undefined);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [isMutating, setIsMutating] = useState(false);
  const [pendingRestore, setPendingRestore] = useState<HistoryReference>();
  const [restoredHead, setRestoredHead] = useState<RestoredProjectHead>();
  const [status, setStatus] = useState(initialState === undefined
    ? "버전과 복구 기록을 불러오는 중…"
    : historyLoadedStatus(initialState.versions.length, initialState.recovery.length));
  const [error, setError] = useState<string>();
  const [stale, setStale] = useState(false);
  const createAttempt = useRef<{ readonly key: string; readonly signature: string } | null>(null);
  const restoreAttemptKey = useRef<string | null>(null);
  const restoreTriggerRef = useRef<HTMLButtonElement | null>(null);
  const owner = { ownerType: project.ownerType, ownerId: project.ownerId } as const;

  useEffect(() => {
    if (initialState !== undefined) {
      setVersions(initialState.versions);
      setRecovery(sortRecoveryCheckpoints(initialState.recovery));
      setCursor(initialState.nextCursor);
      setStatus(historyLoadedStatus(initialState.versions.length, initialState.recovery.length));
      setError(undefined);
      setIsLoading(false);
      return;
    }

    const controller = new AbortController();
    setIsLoading(true);
    setError(undefined);
    void Promise.all([
      listProjectVersions(createBrowserApiClient(), {
        owner, projectId: project.id, pageSize: VERSION_PAGE_SIZE
      }, { signal: controller.signal }),
      listRecoveryCheckpoints(createBrowserApiClient(), {
        owner, projectId: project.id
      }, { signal: controller.signal })
    ]).then(([versionResult, recoveryResult]) => {
      if (controller.signal.aborted) return;
      setVersions(versionResult.data.items);
      setCursor(versionResult.data.nextCursor);
      setRecovery(sortRecoveryCheckpoints(recoveryResult.data.items));
      setStatus(historyLoadedStatus(versionResult.data.items.length, recoveryResult.data.items.length));
    }).catch((cause: unknown) => {
      if (!controller.signal.aborted) {
        setError(historyFailureMessage(cause, "read"));
        setStatus("기록을 불러오지 못했습니다.");
      }
    }).finally(() => {
      if (!controller.signal.aborted) setIsLoading(false);
    });
    return () => controller.abort();
  }, [initialState, project.id, project.ownerId, project.ownerType]);

  async function refreshRecovery(): Promise<void> {
    const result = await listRecoveryCheckpoints(createBrowserApiClient(), { owner, projectId: project.id });
    setRecovery(sortRecoveryCheckpoints(result.data.items));
  }

  async function loadMore(): Promise<void> {
    if (cursor === null || isLoadingMore) return;
    setIsLoadingMore(true);
    setError(undefined);
    try {
      const result = await listProjectVersions(createBrowserApiClient(), {
        owner, projectId: project.id, pageSize: VERSION_PAGE_SIZE, cursor
      });
      setVersions((current) => appendUniqueVersions(current, result.data.items));
      setCursor(result.data.nextCursor);
      setStatus(`버전 ${result.data.items.length}개를 더 불러왔습니다.`);
    } catch (cause) {
      setError(historyFailureMessage(cause, "read"));
    } finally {
      setIsLoadingMore(false);
    }
  }

  async function createVersion(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (project.state !== "active" || projectEtag === undefined || isMutating) return;
    const form = event.currentTarget;
    const name = String(new FormData(form).get("versionName") ?? "").trim();
    setIsMutating(true);
    setError(undefined);
    setStale(false);
    setStatus("현재 서버 저장본으로 명시적인 버전을 만드는 중…");
    const signature = `${projectEtag}\n${name}`;
    if (createAttempt.current?.signature !== signature) {
      createAttempt.current = { key: idempotencyKey("version"), signature };
    }
    const key = createAttempt.current.key;
    try {
      const result = await createProjectVersion(createBrowserApiClient(), {
        owner,
        projectId: project.id,
        name,
        projectEtag,
        idempotencyKey: key
      }, { csrfToken: readCsrfCredential() });
      setVersions((current) => appendUniqueVersions([result.data.version], current));
      createAttempt.current = null;
      form.reset();
      setStatus(result.replayed ? "버전 생성 결과를 안전하게 확인했습니다." : `“${result.data.version.name}” 버전을 만들었습니다.`);
    } catch (cause) {
      const isStale = staleProject(cause);
      setStale(isStale);
      setError(historyFailureMessage(cause, "create"));
      setStatus(isStale ? "서버에 더 최신 프로젝트가 있어 버전을 만들지 않았습니다." : "버전 만들기를 안전하게 다시 시도할 수 있습니다.");
    } finally {
      setIsMutating(false);
    }
  }

  async function confirmRestore(): Promise<void> {
    const reference = pendingRestore;
    if (reference === undefined || project.state !== "active" || projectEtag === undefined || isMutating) return;
    setIsMutating(true);
    setError(undefined);
    setStale(false);
    setStatus(`${reference.label}을 서버 작업 버전으로 복구하는 중…`);
    const key = restoreAttemptKey.current ??= idempotencyKey("restore");
    try {
      const input = {
        owner,
        projectId: project.id,
        referenceKind: reference.kind,
        referenceId: reference.id,
        projectEtag,
        idempotencyKey: key
      } as const;
      let result;
      try {
        result = await restoreProjectHistory(createBrowserApiClient(), input, {
          csrfToken: readCsrfCredential()
        });
      } catch (cause) {
        if (!outcomeMayBeUnknown(cause)) throw cause;
        setStatus("복구 결과를 확인할 수 없어 서버 상태를 조회하는 중…");
        result = await reconcileProjectHistory(createBrowserApiClient(), {
          owner, projectId: project.id, idempotencyKey: key
        });
      }
      onProjectCommit({ projectEtag: result.projectEtag, projectVersion: result.data.projectVersion });
      setRestoredHead({ projectEtag: result.projectEtag, projectVersion: result.data.projectVersion });
      restoreAttemptKey.current = null;
      restoreTriggerRef.current = null;
      setPendingRestore(undefined);
      setStatus(`서버 작업 버전은 이제 v${result.data.projectVersion}입니다. 브라우저의 로컬 초안은 바꾸지 않았습니다.`);
      void refreshRecovery().catch(() => {
        setError("서버 작업 버전은 복구했지만 복구 지점을 새로고침하지 못했습니다. 로컬 초안은 그대로 유지됩니다.");
      });
    } catch (cause) {
      const isStale = staleProject(cause);
      setStale(isStale);
      setError(historyFailureMessage(cause, "restore"));
      setStatus(isStale ? "서버에 더 최신 프로젝트가 있어 복구하지 않았습니다." : "복구를 안전하게 다시 시도하거나 결과를 확인할 수 있습니다.");
    } finally {
      setIsMutating(false);
    }
  }

  function openRestore(reference: HistoryReference, trigger: HTMLButtonElement): void {
    restoreTriggerRef.current = trigger;
    setPendingRestore(reference);
  }

  function closeRestore(): void {
    restoreAttemptKey.current = null;
    setPendingRestore(undefined);
    const trigger = restoreTriggerRef.current;
    restoreTriggerRef.current = null;
    globalThis.requestAnimationFrame(() => trigger?.focus());
  }

  const archived = project.state === "archived";
  const styles = historyPanelStyles();
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
      {error ? <div className={`${styles.feedback()} ${styles.error()}`} role="alert"><p>{error}</p>{stale ? <Button className="justify-self-start" type="button" size="sm" onClick={onReloadProject}>최신 프로젝트 다시 불러오기</Button> : null}</div> : null}
      {restoredHead !== undefined ? (
        <div className={`${styles.feedback()} ${styles.restored()}`}>
          <p><strong>서버 v{restoredHead.projectVersion}을 복구했습니다.</strong> {hasLocalDraft ? "현재 로컬 초안은 열린 상태로 그대로 유지됩니다." : "열린 로컬 초안이 없습니다."}</p>
          {!archived && hasLocalDraft ? <Button className="justify-self-start" type="button" size="sm" variant="primary" onClick={() => onResumeRestoredSave(restoredHead)}>로컬 초안을 복구한 서버 저장본으로 교체</Button> : null}
        </div>
      ) : null}

      {!archived ? (
        <form className={styles.createForm()} onSubmit={createVersion} aria-busy={isMutating}>
          <TextField label="버전 이름" name="versionName" required maxLength={200} disabled={isMutating || projectEtag === undefined} />
          <Button type="submit" size="sm" disabled={isMutating || projectEtag === undefined}>{isMutating ? "처리 중…" : "버전 만들기"}</Button>
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
      {cursor !== null ? <Button className={styles.more()} type="button" size="sm" disabled={isLoadingMore} onClick={() => void loadMore()}>{isLoadingMore ? "불러오는 중…" : `버전 ${VERSION_PAGE_SIZE}개 더 보기`}</Button> : null}

      <ConfirmationDialog
        busy={isMutating}
        confirmLabel={isMutating ? "복구 중…" : "서버 작업 버전 복구"}
        description={pendingRestore === undefined ? "" : `선택한 ${formatTimestamp(pendingRestore.createdAt)} 스냅샷을 새로운 서버 작업 버전으로 지정합니다. ${hasLocalDraft ? "직접 교체하기 전까지 열린 로컬 초안은 그대로 유지됩니다." : "브라우저가 로컬 초안을 자동으로 시작하거나 교체하지 않습니다."}`}
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
      {isLoading ? <p className={styles.listEmpty()}>불러오는 중…</p> : items.length === 0 ? <p className={styles.listEmpty()}>아직 {heading}이 없습니다.</p> : (
        <ScrollAreaRoot className={styles.scrollRoot()}>
          <ScrollAreaViewport>
            <ScrollAreaContent>
              <ol className={styles.list()}>
                {items.map((item) => <li className={styles.item()} key={item.id}><div className={styles.itemLayout()}><div className={styles.itemCopy()}><strong title={item.label}>{item.label}</strong><p>{formatTimestamp(item.createdAt)} · {item.detail}</p></div>{archived ? null : <Button type="button" size="sm" disabled={isMutating} onClick={(event) => onRestore(item, event.currentTarget)}>복구</Button>}</div></li>)}
              </ol>
            </ScrollAreaContent>
          </ScrollAreaViewport>
          <ScrollAreaScrollbar><ScrollAreaThumb /></ScrollAreaScrollbar>
        </ScrollAreaRoot>
      )}
    </section>
  );
}

function idempotencyKey(action: string): string {
  return `history-${action}-${globalThis.crypto.randomUUID()}`;
}

function historyLoadedStatus(versionCount: number, recoveryCount: number): string {
  return `버전 ${versionCount}개와 복구 지점 ${recoveryCount}개를 불러왔습니다.`;
}

function appendUniqueVersions(first: readonly ProjectVersion[], second: readonly ProjectVersion[]): readonly ProjectVersion[] {
  const seen = new Set<string>();
  return [...first, ...second].filter((item) => seen.has(item.id) ? false : (seen.add(item.id), true));
}

export function sortRecoveryCheckpoints(items: readonly RecoveryCheckpoint[]): readonly RecoveryCheckpoint[] {
  return [...items].sort((left, right) => {
    const instantOrder = Date.parse(right.createdAt) - Date.parse(left.createdAt);
    return instantOrder || right.id.localeCompare(left.id);
  });
}

function staleProject(cause: unknown): boolean {
  return cause instanceof ApiError && (cause.status === 412 || cause.status === 428);
}

function outcomeMayBeUnknown(cause: unknown): boolean {
  return cause instanceof ApiTimeoutError ||
    cause instanceof ApiTransportError ||
    cause instanceof ApiInvalidResponseError ||
    cause instanceof ApiResponseTooLargeError ||
    (cause instanceof ApiError && (cause.code === "COMMIT_OUTCOME_UNKNOWN" || cause.code === "RECONCILIATION_REQUIRED"));
}

function historyFailureMessage(cause: unknown, action: "create" | "read" | "restore"): string {
  if (cause instanceof ApiError) {
    if (cause.status === 412 || cause.status === 428) return "서버 프로젝트가 변경되었습니다. 로컬 초안은 보존되므로 최신 프로젝트를 불러온 뒤 다시 시도하세요.";
    if (cause.status === 403) return "이 기록 작업을 수행할 권한이 없습니다.";
    if (cause.code === "COMMIT_OUTCOME_UNKNOWN" || cause.code === "RECONCILIATION_REQUIRED") return "서버 처리 결과를 아직 확인할 수 없습니다. 로컬 초안은 보존되므로 서비스가 준비되면 결과 확인을 다시 시도하세요.";
  }
  if (action === "read") return "기록을 일시적으로 사용할 수 없습니다. 로컬 초안을 변경하지 않고 다시 시도할 수 있습니다.";
  return `${action === "create" ? "버전 만들기" : "기록 복구"}를 완료하지 못했습니다. 로컬 초안은 보존되므로 같은 작업을 안전하게 다시 시도할 수 있습니다.`;
}

function formatTimestamp(value: string): string {
  return timestampFormatter.format(new Date(value));
}

function formatBytes(value: number): string {
  if (value < 1_024) return `${value} B`;
  if (value < 1_048_576) return `${(value / 1_024).toFixed(1)} KiB`;
  return `${(value / 1_048_576).toFixed(1)} MiB`;
}
