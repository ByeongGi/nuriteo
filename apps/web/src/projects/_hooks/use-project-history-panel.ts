"use client";

import { useEffect, useRef, useState } from "react";

import { createBrowserApiClient } from "@/lib/api/browser-client.ts";
import { readCsrfCredential } from "@/lib/api/browser-security.ts";
import { projectVersionNameSchema } from "@/projects/_schema/project-history.ts";
import {
  VERSION_PAGE_SIZE,
  appendUniqueVersions,
  historyFailureMessage,
  historyLoadedStatus,
  idempotencyKey,
  outcomeMayBeUnknown,
  sortRecoveryCheckpoints,
  staleProject
} from "@/projects/_utils/project-history.ts";
import {
  createProjectVersion,
  listProjectVersions,
  listRecoveryCheckpoints,
  reconcileProjectHistory,
  restoreProjectHistory
} from "@/services/projects/api.ts";

import type { FormEvent } from "react";
import type {
  HistoricalReferenceKind,
  Project,
  ProjectVersion,
  RecoveryCheckpoint
} from "@nuriteo/api-client";

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

export function useProjectHistoryPanel({
  initialState,
  onProjectCommit,
  project,
  projectEtag
}: {
  readonly initialState?: ProjectHistoryState | undefined;
  readonly onProjectCommit: (result: { readonly projectEtag: string; readonly projectVersion: number }) => void;
  readonly project: Project;
  readonly projectEtag?: string | undefined;
}) {
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
    const parsed = projectVersionNameSchema.safeParse(String(new FormData(form).get("versionName") ?? "").trim());
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "입력값을 확인하세요.");
      return;
    }
    const name = parsed.data;
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

  return {
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
  };
}

export type { HistoryReference };
