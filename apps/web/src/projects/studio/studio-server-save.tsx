"use client";

import { Button } from "#src/components/ui/button.tsx";
import { createBrowserApiClient } from "#src/lib/api/browser-client.ts";
import { readCsrfCredential } from "#src/lib/api/browser-security.ts";
import { createRetryableLazyFeature } from "#src/lib/retryable-lazy-feature.ts";
import { recoveryActionLabel, serverSavePhaseLabel } from "#src/projects/studio/studio-shell-labels.ts";
import type { StudioShellSession } from "#src/projects/studio/studio-shell-session.ts";
import type { RuntimeRecoveryActionKind } from "#src/runtime/runtime-adapter.ts";

type SaveFeature = typeof import("#src/save/project-save.ts");
const saveFeature = createRetryableLazyFeature<SaveFeature>(() => import("#src/save/project-save.ts"));

export function bindStudioServerSave(session: StudioShellSession): void {
  const {
    adapterRef,
    confirmingWriterTakeover,
    editorDraftsRef,
    isServerSaving,
    onProjectCommit,
    previewConfiguration,
    project,
    projectEtag,
    recoveringAction,
    runtime,
    saveAbortRef,
    setConfirmingWriterTakeover,
    setEditorStatus,
    setError,
    setHasUnpublishedChanges,
    setIsServerSaving,
    setRecoveringAction,
    setRuntime,
    setServerSaveFailure,
    setServerSaveStatus,
    unmountedRef
  } = session;
  async function executeRecovery(kind: RuntimeRecoveryActionKind) {
    if (kind === "resolve-writer-conflict" && !confirmingWriterTakeover) {
      setConfirmingWriterTakeover(true);
      return;
    }
    const adapter = adapterRef.current;
    if (!adapter || recoveringAction) return;
    setError(undefined);
    setRecoveringAction(kind);
    try {
      const next = await adapter.recovery.run(kind);
      setRuntime(next);
      setConfirmingWriterTakeover(false);
      if (kind === "clear-cache") {
        setEditorStatus("패키지 캐시 삭제됨 · 로컬 초안 보존됨");
      } else if (kind === "resolve-writer-conflict") {
        setEditorStatus("편집 권한 획득 · 로컬 초안 보존됨");
      }
      if (
        next.previewUrl
        && previewConfiguration.status === "enabled"
        && (kind === "retry" || kind === "reset-runtime" || kind === "restart-dev-server")
      ) {
        await session.swapPreviewBridge(adapter, next.previewUrl);
      }
    } catch (error) {
      if (!unmountedRef.current && adapterRef.current === adapter) {
        const cause = error instanceof Error ? error.message.trim() : "";
        if (cause === "Preview controller operation cancelled") setError(undefined);
        else setError(cause || "복구를 완료하지 못했습니다. 로컬 초안은 유지되므로 작업을 확인한 뒤 다시 시도하세요.");
      }
    } finally {
      if (!unmountedRef.current) setRecoveringAction(undefined);
    }
  }

  async function saveToServer() {
    const adapter = adapterRef.current;
    if (!adapter || !projectEtag || isServerSaving || runtime.localDraftAccess !== "writer") return;
    const controller = new AbortController();
    saveAbortRef.current?.abort();
    saveAbortRef.current = controller;
    setError(undefined);
    setServerSaveFailure(undefined);
    setIsServerSaving(true);
    setServerSaveStatus("서버 저장 계획을 준비하는 중…");
    try {
      const hadPendingDraft = editorDraftsRef.current.pending.size > 0;
      session.flushPendingDrafts(adapter);
      if (hadPendingDraft) setEditorStatus("서버 저장을 위해 로컬 초안에 적용됨");
      const { saveCurrentProject } = await saveFeature.load();
      const result = await saveCurrentProject({
        client: createBrowserApiClient(),
        csrfToken: readCsrfCredential(),
        owner: { ownerType: project.ownerType, ownerId: project.ownerId },
        projectId: project.id,
        storageScopeId: project.storageScopeId,
        projectEtag,
        snapshotCurrentTree: () => adapter.workspace.snapshotBundleFiles(),
        currentRevision: () => adapter.workspace.currentRevision(),
        signal: controller.signal,
        onProgress(progress) {
          if (controller.signal.aborted) return;
          const percentage = progress.totalBytes && progress.uploadedBytes > 0
            ? ` ${Math.floor(progress.uploadedBytes * 100 / progress.totalBytes)}%`
            : "";
          setServerSaveStatus(`${serverSavePhaseLabel(progress.phase)}${percentage} · 로컬 초안 보존됨`);
        }
      });
      onProjectCommit?.({ projectEtag: result.projectEtag, projectVersion: result.projectVersion });
      setServerSaveStatus(result.snapshotCurrent
        ? `서버 저장 v${result.projectVersion} 완료 · 로컬 초안과 일치`
        : `서버 저장 v${result.projectVersion} 완료 · 더 최신 로컬 변경 남음`);
      setHasUnpublishedChanges(!result.snapshotCurrent);
    } catch (cause) {
      if (!controller.signal.aborted) {
        const stale = cause instanceof Error && "status" in cause && (cause as { status?: unknown }).status === 412;
        setServerSaveFailure(stale ? "stale" : "retry");
        setError(stale
          ? "저장 전에 서버 프로젝트가 변경되었습니다. 로컬 초안은 보존되므로 최신 프로젝트를 불러온 뒤 다시 시도하세요."
          : "서버 저장을 완료하지 못했습니다. 로컬 초안은 보존되므로 서비스가 준비되면 다시 시도하세요.");
        setServerSaveStatus("서버 저장 실패 · 로컬 초안 보존됨");
      }
    } finally {
      if (saveAbortRef.current === controller) saveAbortRef.current = null;
      if (!unmountedRef.current) setIsServerSaving(false);
    }
  }
  session.executeRecovery = executeRecovery;
  session.saveToServer = saveToServer;
}

export function StudioServerSaveFailure({ session }: { readonly session: StudioShellSession }) {
  const {
    canWriteLocalDraft,
    css,
    isServerSaving,
    onProjectReload,
    saveToServer,
    serverSaveFailure
  } = session;
  function serverSaveRecovery() {
    if (serverSaveFailure === "retry") return (<Button type="button" size="sm" disabled={isServerSaving || !canWriteLocalDraft} onClick={() => void saveToServer()}>서버 저장 다시 시도</Button>);
    return (<Button type="button" size="sm" onClick={() => onProjectReload?.()}>최신 프로젝트 다시 불러오기</Button>);
  }
  return (
    <>
      {serverSaveFailure ? <div className={css.recoveryActions()} aria-label="서버 저장 복구">{serverSaveRecovery()}</div> : null}
    </>
  );
}

export function StudioWorkspaceRecovery({ session }: { readonly session: StudioShellSession }) {
  const {
    confirmingWriterTakeover,
    css,
    executeRecovery,
    recoveringAction,
    recoveryDiagnostics,
    setConfirmingWriterTakeover
  } = session;
  function writerTakeoverDialog() {
    if (confirmingWriterTakeover) return ((
            <div className="mt-3 rounded-md border border-danger p-3" role="alertdialog" aria-labelledby="writer-takeover-title">
              <p id="writer-takeover-title" className="m-0 text-sm font-semibold">다른 탭의 편집 권한을 가져올까요?</p>
              <p className="mb-3 mt-1 text-xs text-muted-foreground">다른 탭은 읽기 전용으로 전환됩니다. 저장하지 않은 편집 내용은 그대로 보이지만 이 탭에서만 로컬 초안을 쓸 수 있습니다.</p>
              <div className="flex gap-2">
                <Button type="button" size="sm" variant="primary" onClick={() => void executeRecovery("resolve-writer-conflict")}>이 탭에서 편집 시작</Button>
                <Button type="button" size="sm" onClick={() => setConfirmingWriterTakeover(false)}>취소</Button>
              </div>
            </div>
          ));
    return (null);
  }
  return (
    <>
      {recoveryDiagnostics.length > 0 ? (
        <section className={css.recovery()} aria-label="워크스페이스 복구">
          <h4 className="m-0 text-sm font-semibold">워크스페이스 확인이 필요합니다</h4>
          {recoveryDiagnostics.map((diagnostic) => (
            <div className="mt-2" key={diagnostic.code}>
              <p className="m-0 text-sm"><span className="font-mono text-xs">{diagnostic.code}</span> · {diagnostic.message}</p>
              <div className="mt-2 flex flex-wrap gap-2">
                {diagnostic.actions.map((action) => {
                  function recoveryButtonLabel(): string {
                    if (recoveringAction === action.kind) return ("복구 중…");
                    return (recoveryActionLabel(action.kind));
                  }
                  return (
                  <Button
                    type="button"
                    size="sm"
                    key={`${diagnostic.code}:${action.kind}`}
                    disabled={recoveringAction !== undefined}
                    onClick={() => void executeRecovery(action.kind)}
                  >
                    {recoveryButtonLabel()}
                  </Button>
                );
                })}
              </div>
            </div>
          ))}
          {writerTakeoverDialog()}
        </section>
      ) : null}
    </>
  );
}

