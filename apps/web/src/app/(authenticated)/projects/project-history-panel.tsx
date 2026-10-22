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
import type { FormEvent, KeyboardEvent as ReactKeyboardEvent } from "react";

import { Button } from "#src/components/ui/button.tsx";
import { createBrowserApiClient } from "#src/lib/api/browser-client.ts";
import { readCsrfCredential } from "#src/lib/api/browser-security.ts";

const VERSION_PAGE_SIZE = 20;

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
  const confirmButtonRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
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

  useEffect(() => {
    if (pendingRestore === undefined) return;
    confirmButtonRef.current?.focus();
    const dismiss = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !isMutating) closeRestore();
    };
    globalThis.addEventListener("keydown", dismiss);
    return () => globalThis.removeEventListener("keydown", dismiss);
  }, [isMutating, pendingRestore]);

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

  function trapDialogFocus(event: ReactKeyboardEvent<HTMLElement>): void {
    if (event.key !== "Tab") return;
    const controls = [...(dialogRef.current?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    ) ?? [])].filter((element) => element.tabIndex >= 0);
    const first = controls[0];
    const last = controls.at(-1);
    if (first === undefined || last === undefined) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  const archived = project.state === "archived";
  return (
    <section className="mt-4 rounded-lg border border-border bg-surface p-4" aria-labelledby={`history-title-${project.id}`}>
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="m-0 text-xs uppercase tracking-wide text-muted-foreground">서버 기록</p>
          <h3 id={`history-title-${project.id}`} className="m-0 text-sm font-semibold">버전과 복구</h3>
          <p className="mb-0 mt-1 text-xs text-muted-foreground">복구는 서버 작업 버전만 변경합니다. 이 브라우저의 로컬 초안을 자동으로 덮어쓰지 않습니다.</p>
        </div>
        {archived ? <span className="rounded-md border border-border bg-subtle px-2 py-1 text-xs">보관됨 · 읽기 전용</span> : null}
      </header>

      <p className="mt-3 text-sm text-muted-foreground" role="status" aria-live="polite">{status}</p>
      {error ? <div className="mt-3 rounded-md border border-danger p-3" role="alert"><p className="m-0 text-sm text-danger">{error}</p>{stale ? <Button className="mt-2" type="button" size="sm" onClick={onReloadProject}>최신 프로젝트 다시 불러오기</Button> : null}</div> : null}
      {restoredHead !== undefined ? (
        <div className="mt-3 rounded-md border border-warning bg-subtle p-3">
          <p className="m-0 text-sm"><strong>서버 v{restoredHead.projectVersion}을 복구했습니다.</strong> {hasLocalDraft ? "현재 로컬 초안은 열린 상태로 그대로 유지됩니다." : "열린 로컬 초안이 없습니다."}</p>
          {archived ? null : <Button className="mt-2" type="button" size="sm" variant="primary" onClick={() => onResumeRestoredSave(restoredHead)}>로컬 초안을 복구한 서버 저장본으로 교체</Button>}
        </div>
      ) : null}

      {!archived ? (
        <form className="mt-4 flex flex-wrap items-end gap-2" onSubmit={createVersion} aria-busy={isMutating}>
          <label className="field-group min-w-64 flex-1">버전 이름<input name="versionName" required maxLength={200} disabled={isMutating || projectEtag === undefined} /></label>
          <Button type="submit" size="sm" disabled={isMutating || projectEtag === undefined}>{isMutating ? "처리 중…" : "버전 만들기"}</Button>
        </form>
      ) : null}

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
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
      {cursor !== null ? <Button className="mt-3" type="button" size="sm" disabled={isLoadingMore} onClick={() => void loadMore()}>{isLoadingMore ? "불러오는 중…" : "버전 더 보기"}</Button> : null}

      {pendingRestore ? (
        <div className="fixed inset-0 z-50 grid place-items-center bg-background/80 p-4" role="presentation">
          <section ref={dialogRef} className="max-w-lg rounded-lg border border-danger bg-surface p-5 shadow-lg" role="alertdialog" aria-modal="true" aria-labelledby={`restore-title-${pendingRestore.id}`} aria-describedby={`restore-description-${pendingRestore.id}`} onKeyDown={trapDialogFocus}>
            <h4 id={`restore-title-${pendingRestore.id}`} className="m-0 text-base font-semibold">{pendingRestore.label}을 복구할까요?</h4>
            <p id={`restore-description-${pendingRestore.id}`} className="mt-2 text-sm text-muted-foreground">선택한 스냅샷을 새로운 서버 작업 버전으로 지정합니다. {hasLocalDraft ? "직접 교체하기 전까지 열린 로컬 초안은 그대로 유지됩니다." : "브라우저가 로컬 초안을 자동으로 시작하거나 교체하지 않습니다."}</p>
            <div className="mt-4 flex flex-wrap gap-2">
              <Button ref={confirmButtonRef} type="button" size="sm" variant="danger" disabled={isMutating} onClick={() => void confirmRestore()}>{isMutating ? "복구 중…" : "서버 작업 버전 복구"}</Button>
              <Button type="button" size="sm" disabled={isMutating} onClick={closeRestore}>취소</Button>
            </div>
          </section>
        </div>
      ) : null}
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
  return (
    <section aria-label={heading}>
      <h4 className="m-0 text-sm font-semibold">{heading}</h4>
      {isLoading ? <p className="text-sm text-muted-foreground">불러오는 중…</p> : items.length === 0 ? <p className="text-sm text-muted-foreground">아직 {heading}이 없습니다.</p> : (
        <ol className="mt-2 grid list-none gap-2 p-0">
          {items.map((item) => <li className="rounded-md border border-muted-border p-3" key={item.id}><div className="flex items-start justify-between gap-2"><div><strong className="text-sm">{item.label}</strong><p className="m-0 text-xs text-muted-foreground">{formatTimestamp(item.createdAt)} · {item.detail}</p></div>{archived ? null : <Button type="button" size="sm" disabled={isMutating} onClick={(event) => onRestore(item, event.currentTarget)}>복구</Button>}</div></li>)}
        </ol>
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
  return new Intl.DateTimeFormat("ko-KR", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function formatBytes(value: number): string {
  if (value < 1_024) return `${value} B`;
  if (value < 1_048_576) return `${(value / 1_024).toFixed(1)} KiB`;
  return `${(value / 1_048_576).toFixed(1)} MiB`;
}
