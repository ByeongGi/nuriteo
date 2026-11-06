"use client";

import { Button } from "#src/components/ui/button.tsx";
import { createRetryableLazyFeature } from "#src/lib/retryable-lazy-feature.ts";
import { createEditorDraftState, createEditorTabs } from "@/projects/studio/_utils/editor-tabs.ts";
import { projectContentErrorCode, projectTemplateLabel, resumeErrorMessage, runtimeErrorCode } from "@/projects/studio/_utils/studio-shell-labels.ts";
import {
  EMPTY_RUNTIME_STATE,
  FILE_LIST_BATCH_SIZE,
  INITIAL_SERVER_SAVE_STATUS,
  RUNTIME_BOOT_TIMEOUT_MS,
  RUNTIME_MEMORY_LIMIT_BYTES,
  RUNTIME_RELAY_TIMEOUT_MS,
  type StudioShellSession
} from "@/projects/studio/_utils/studio-shell-session.ts";
import { resolveRuntimeAssetRevision } from "#src/runtime/runtime-assets.ts";
import type { RuntimeWorkspaceState } from "#src/runtime/runtime-adapter.ts";
import { awaitWorkspaceStart } from "#src/runtime/workspace-start.ts";

type RuntimeFeature = typeof import("#src/runtime/runtime-adapter.ts");
const runtimeFeature = createRetryableLazyFeature<RuntimeFeature>(
  () => import("#src/runtime/runtime-adapter.ts")
);
type ResumeFeature = typeof import("#src/resume/project-content.ts");
const resumeFeature = createRetryableLazyFeature<ResumeFeature>(
  () => import("#src/resume/project-content.ts")
);

export function bindStudioWorkspace(session: StudioShellSession): void {
  const {
    adapterRef,
    assetRevision,
    editorDraftsRef,
    manifestAbortRef,
    previewBridgeOperationRef,
    previewBridgeRef,
    previewConfiguration,
    project,
    resumeProjectContentLoader,
    runtimeFeatureLoader,
    saveAbortRef,
    setBottomPanel,
    setConfirmingWorkspaceStop,
    setEditorDiagnostics,
    setEditorDrafts,
    setEditorPositionRequest,
    setEditorStatus,
    setEditorTabs,
    setError,
    setFileListLimit,
    setFileOperation,
    setFileOperationValue,
    setFileQuery,
    setHasUnpublishedChanges,
    setIsEditorSplit,
    setIsFocusMode,
    setIsPreviewOpen,
    setIsSidebarOpen,
    setIsStarting,
    setIsTerminalOpen,
    setIsolatedPreviewUrl,
    setMatchFileCase,
    setPreviewConsole,
    setReplaceQuery,
    setResumeStatus,
    setRuntime,
    setSelectedPath,
    setServerSaveFailure,
    setServerSaveStatus,
    setSidebarPanel,
    setSplitPath,
    setUseFileRegularExpression,
    setWorkspace,
    terminal,
    unmountedRef,
    unsubscribeRef,
    workspaceScope,
    workspaceStartOperationRef
  } = session;
  async function startWorkspace() {
    if (adapterRef.current !== undefined) {
      setError("완전히 종료되지 않은 워크스페이스입니다. 프로젝트를 새로고침한 뒤 다시 시도하세요.");
      return;
    }
    const operation = workspaceStartOperationRef.current + 1;
    workspaceStartOperationRef.current = operation;
    setError(undefined);
    setServerSaveFailure(undefined);
    setServerSaveStatus(INITIAL_SERVER_SAVE_STATUS);
    setIsStarting(true);
    setResumeStatus("현재 서버 저장본을 확인하는 중…");
    try {
      manifestAbortRef.current?.abort();
      const manifestAbort = new AbortController();
      manifestAbortRef.current = manifestAbort;
      const runtimePromise = runtimeFeatureLoader?.() ?? runtimeFeature.load();
      const revisionPromise = resolveRuntimeAssetRevision(assetRevision, manifestAbort.signal);
      const savedContentPromise = (resumeProjectContentLoader?.() ?? resumeFeature.load())
        .then(({ resumeProjectContent }) => resumeProjectContent({
            ownerType: project.ownerType,
            ownerId: project.ownerId,
            projectId: project.id,
            storageScopeId: project.storageScopeId
          }, { signal: manifestAbort.signal }))
        .catch((caught: unknown) => {
          if (projectContentErrorCode(caught) === "RESUME_NOT_SAVED") return undefined;
          throw caught;
        });
      const [{ createRuntimeAdapter }, revision, savedContent] = await awaitWorkspaceStart(manifestAbort, {
        runtime: runtimePromise,
        revision: revisionPromise,
        content: savedContentPromise
      });
      if (unmountedRef.current || workspaceStartOperationRef.current !== operation) return;
      const source = savedContent === undefined ? "template" : "saved";
      setResumeStatus(source === "saved" ? "검증 완료. 저장된 프로젝트를 여는 중…" : "저장본이 없어 시작 템플릿을 만드는 중…");
      const adapter = createRuntimeAdapter();
      adapterRef.current = adapter;
      unsubscribeRef.current();
      unsubscribeRef.current = adapter.subscribe(setRuntime);
      const origin = globalThis.location.origin;
      const base = `/runtime/${revision}`;
      await adapter.mount({
        project: {
          id: project.id,
          storageScopeId: project.storageScopeId,
          workspaceScopeId: workspaceScope,
          displayName: project.name
        },
        assets: {
          systemWorkerUrl: new URL(`${base}/system-worker.js`, origin),
          processWorkerUrl: new URL(`${base}/process-worker.js`, origin),
          systemWasmUrl: new URL(`${base}/system.wasm`, origin),
          previewServiceWorkerUrl: new URL(`${base}/preview-sw.js`, origin)
        },
        policy: {
          bootTimeoutMs: RUNTIME_BOOT_TIMEOUT_MS,
          relayTimeoutMs: RUNTIME_RELAY_TIMEOUT_MS,
          memoryLimitBytes: RUNTIME_MEMORY_LIMIT_BYTES
        },
        reportDiagnostic(diagnostic) {
          if (diagnostic.severity === "error") setError(diagnostic.message);
        }
      });
      let materialized: RuntimeWorkspaceState;
      if (source === "template") {
        materialized = await adapter.workspace.materializeTemplate(project.templateId);
      } else {
        if (savedContent === undefined) throw new Error("Saved project content is unavailable.");
        materialized = await adapter.workspace.materializeBundle(savedContent.files);
      }
      const requestedPath = new URL(globalThis.location.href).searchParams.get("file");
      const firstTextFile = materialized.files.find((file) => file.kind === "text" && file.path === requestedPath)
        ?? materialized.files.find((file) => file.kind === "text");
      setWorkspace(materialized);
      const freshDrafts = createEditorDraftState();
      editorDraftsRef.current = freshDrafts;
      setEditorDrafts(freshDrafts);
      setEditorTabs(createEditorTabs());
      if (source === "template") {
        setHasUnpublishedChanges(true);
        setEditorStatus("로컬 초안");
        setResumeStatus("이 브라우저에 시작 템플릿을 준비했습니다.");
      } else {
        if (savedContent === undefined) throw new Error("Saved project content is unavailable.");
        setHasUnpublishedChanges(false);
        setEditorStatus(`서버 저장본 v${savedContent.descriptor.projectVersion} 복원됨`);
        setResumeStatus(`이 브라우저에 서버 저장본 v${savedContent.descriptor.projectVersion}을 준비했습니다.`);
      }
      if (firstTextFile) session.selectFile(firstTextFile.path, materialized, "preview");
      if (previewConfiguration.status === "enabled") void session.startPreview(adapter);
    } catch (caught) {
      if (workspaceStartOperationRef.current !== operation) return;
      const contentCode = projectContentErrorCode(caught);
      const runtimeCode = runtimeErrorCode(caught);
      const runtimeCodeSuffix = runtimeCode ? (` (${runtimeCode})`) : ("");
      setError(contentCode === null
        ? `브라우저 워크스페이스를 안전하게 시작하지 못했습니다.${runtimeCodeSuffix}`
        : resumeErrorMessage(contentCode));
      setResumeStatus(undefined);
      await releaseAdapter();
    } finally {
      if (workspaceStartOperationRef.current === operation) {
        manifestAbortRef.current = null;
        setIsStarting(false);
      }
    }
  }

  async function stopWorkspace() {
    saveAbortRef.current?.abort();
    const adapter = adapterRef.current;
    await releaseAdapter();
    if (adapter?.getState().lifecycle === "failed") {
      setError("브라우저 워크스페이스가 일부 자원을 종료하지 못했습니다. 새로고침한 뒤 다시 시도하세요.");
      return;
    }
    setWorkspace(undefined);
    setSelectedPath(undefined);
    const freshDrafts = createEditorDraftState();
    editorDraftsRef.current = freshDrafts;
    setEditorDrafts(freshDrafts);
    setEditorTabs(createEditorTabs());
    session.showEditorText("");
    setEditorDiagnostics([]);
    setPreviewConsole([]);
    setIsEditorSplit(false);
    setSplitPath(undefined);
    session.showSplitText("");
    setReplaceQuery("");
    setEditorPositionRequest(undefined);
    terminal.reset();
    setEditorStatus("로컬 초안");
    setResumeStatus(undefined);
    setFileQuery("");
    setFileListLimit(FILE_LIST_BATCH_SIZE);
    setSidebarPanel("files");
    setFileOperation(undefined);
    setFileOperationValue("");
    setIsSidebarOpen(true);
    setMatchFileCase(false);
    setUseFileRegularExpression(false);
    setIsPreviewOpen(true);
    setIsTerminalOpen(false);
    setBottomPanel("terminal");
    setIsFocusMode(false);
    setHasUnpublishedChanges(false);
    setError(undefined);
    setServerSaveFailure(undefined);
    setServerSaveStatus(INITIAL_SERVER_SAVE_STATUS);
    setConfirmingWorkspaceStop(false);
  }

  async function releaseAdapter() {
    previewBridgeOperationRef.current += 1;
    const bridge = previewBridgeRef.current;
    previewBridgeRef.current = undefined;
    if (!unmountedRef.current) setIsolatedPreviewUrl(undefined);
    await bridge?.dispose();
    const adapter = adapterRef.current;
    if (!adapter) return;
    await adapter.dispose();
    if (adapter.getState().lifecycle !== "failed") {
      unsubscribeRef.current();
      unsubscribeRef.current = () => undefined;
      adapterRef.current = undefined;
      setRuntime(EMPTY_RUNTIME_STATE);
    }
  }
  session.startWorkspace = startWorkspace;
  session.stopWorkspace = stopWorkspace;
  session.releaseAdapter = releaseAdapter;
}

export function StudioWorkspaceStart({ session }: { readonly session: StudioShellSession }) {
  const {
    css,
    error,
    isStarting,
    project,
    startWorkspace
  } = session;
  const studioStartActionLabel = error ? ("다시 시도") : ("Studio 열기");
  function studioStartButton() {
    if (!isStarting && project.state === "active") return (<Button type="button" variant="primary" onClick={() => void startWorkspace()}>{studioStartActionLabel}</Button>);
    return (null);
  }
  const studioRestartHint = project.state === "active" ? ("프로젝트에 고정된 시작 템플릿으로 Studio를 다시 열 수 있습니다.") : ("활성 프로젝트만 Studio에서 열 수 있습니다.");
  const studioStartHint = isStarting ? (`저장본을 확인한 뒤, 저장본이 없으면 프로젝트에 고정된 ${projectTemplateLabel(project.templateId)} 템플릿을 자동으로 엽니다.`) : (error ?? (studioRestartHint));
  const studioStoppedTitle = error ? ("Studio를 준비하지 못했습니다") : ("Studio가 종료되었습니다");
  const studioIdleTitle = project.state === "active" ? (studioStoppedTitle) : ("보관된 프로젝트입니다");
  const studioPreparingTitle = isStarting ? ("Studio를 준비하고 있습니다") : (studioIdleTitle);
  return (<div className={css.start()} role="status"><span className={css.startMark()} aria-hidden="true">N</span><h4>{studioPreparingTitle}</h4><p>{studioStartHint}</p>{studioStartButton()}</div>);
}

