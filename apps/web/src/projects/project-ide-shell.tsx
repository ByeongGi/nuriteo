"use client";

import type { Project } from "@nuriteo/api-client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";

import { ConfirmationDialog } from "#src/components/ui/confirmation-dialog.tsx";
import { readEditorThemePreference } from "#src/projects/project-editor-theme.ts";
import type { EditorThemePreference } from "#src/projects/project-editor-theme.ts";
import { createEditorDraftState, createEditorTabs } from "#src/projects/studio/editor-tabs.ts";
import type { EditorDraftState, EditorTabs } from "#src/projects/studio/editor-tabs.ts";
import type { StudioConsoleEntry } from "#src/projects/studio/preview-console.ts";
import { visibleStudioExplorerFiles } from "#src/projects/studio/explorer-files.ts";
import { useStudioEditorActions } from "#src/projects/studio/studio-editor-actions.ts";
import { ideStyles } from "#src/projects/studio/studio-ide-styles.ts";
import { workbenchLayoutClass } from "#src/projects/studio/studio-shell-labels.ts";
import { StudioActivityBar, StudioEditorColumn, StudioFileSidebar, StudioQuickOpen, StudioShellHeader } from "#src/projects/studio/studio-shell-chrome.tsx";
import {
  EMPTY_RUNTIME_STATE,
  EMPTY_WORKSPACE_FILES,
  FILE_LIST_BATCH_SIZE,
  INITIAL_SERVER_SAVE_STATUS,
  createStudioShellSession,
  type BottomPanel,
  type EditorDiagnostic,
  type EditorPositionRequest,
  type FileOperation,
  type SidebarPanel
} from "#src/projects/studio/studio-shell-session.ts";
import { StudioPreviewConsole, StudioPreviewConsoleActions, StudioPreviewPanel, StudioPreviewPorts, useStudioPreview } from "#src/projects/studio/studio-preview-session.tsx";
import { StudioServerSaveFailure, StudioWorkspaceRecovery, bindStudioServerSave } from "#src/projects/studio/studio-server-save.tsx";
import { StudioTerminalDock, bindStudioTerminal } from "#src/projects/studio/studio-terminal-session.tsx";
import { StudioWorkspaceStart, bindStudioWorkspace } from "#src/projects/studio/studio-workspace-session.tsx";
import { useUnsavedChangesGuard } from "#src/lib/use-unsaved-changes-guard.ts";
import { useProjectContentSearch, useProjectFileSearch } from "#src/projects/use-project-file-search.ts";
import { useProjectTerminalSessions } from "#src/projects/use-project-terminal-sessions.ts";
import type { RuntimeAdapter, RuntimeRecoveryActionKind, RuntimeViewState, RuntimeWorkspaceState } from "#src/runtime/runtime-adapter.ts";
import { createPreviewHistory } from "#src/runtime/preview-address.ts";
import type { PreviewHistory } from "#src/runtime/preview-address.ts";
import type { PreviewOriginConfiguration } from "#src/runtime/preview-origin-contract.ts";
import { createSubdomainPreviewBridge } from "#src/runtime/subdomain-preview-bridge.ts";
import type { SubdomainPreviewBridge } from "#src/runtime/subdomain-preview-bridge.ts";

type RuntimeFeature = typeof import("#src/runtime/runtime-adapter.ts");
type ResumeFeature = typeof import("#src/resume/project-content.ts");

interface Props {
  readonly assetRevision?: string;
  readonly previewConfiguration: PreviewOriginConfiguration;
  readonly previewBridgeFactory?: typeof createSubdomainPreviewBridge;
  readonly project: Project;
  readonly projectEtag?: string;
  readonly onProjectCommit?: (result: { readonly projectEtag: string; readonly projectVersion: number }) => void;
  readonly onProjectReload?: () => void;
  readonly resumeProjectContentLoader?: () => Promise<Pick<ResumeFeature, "resumeProjectContent">>;
  readonly runtimeFeatureLoader?: () => Promise<RuntimeFeature>;
  readonly workspaceScope: string;
}
export function ProjectIdeShell({ assetRevision, onProjectCommit, onProjectReload, previewBridgeFactory, previewConfiguration, project, projectEtag, resumeProjectContentLoader, runtimeFeatureLoader, workspaceScope }: Props) {
  const adapterRef = useRef<RuntimeAdapter | undefined>(undefined);
  const previewBridgeRef = useRef<SubdomainPreviewBridge | undefined>(undefined);
  const previewFrameRef = useRef<HTMLIFrameElement | null>(null);
  const previewBridgeOperationRef = useRef(0);
  const previewRecoveryRef = useRef<Promise<void> | null>(null);
  const previewWindowDisposersRef = useRef(new Set<() => void>());
  const previewWindowBridgesRef = useRef(new Set<SubdomainPreviewBridge>());
  const unsubscribeRef = useRef<() => void>(() => undefined);
  const manifestAbortRef = useRef<AbortController | null>(null);
  const saveAbortRef = useRef<AbortController | null>(null);
  const fileSearchRef = useRef<HTMLInputElement | null>(null);
  const workbenchRef = useRef<HTMLDivElement | null>(null);
  const unmountedRef = useRef(false);
  const packageSyncGenerationRef = useRef(0);
  const workspaceStartOperationRef = useRef(0);
  const [workspace, setWorkspace] = useState<RuntimeWorkspaceState>();
  const [selectedPath, setSelectedPath] = useState<string>();
  const [editorTabs, setEditorTabs] = useState<EditorTabs>(createEditorTabs);
  const [editorDrafts, setEditorDrafts] = useState<EditorDraftState>(createEditorDraftState);
  const [editorContent, setEditorContent] = useState("");
  const [editorDiagnostics, setEditorDiagnostics] = useState<readonly EditorDiagnostic[]>([]);
  const [previewConsole, setPreviewConsole] = useState<readonly StudioConsoleEntry[]>([]);
  const previewConsoleIdRef = useRef(0);
  const previousServerLogsRef = useRef<readonly string[]>([]);
  const previewCancelRequestedRef = useRef(false);
  const isTerminalOpenRef = useRef(false);
  const [editorPositionRequest, setEditorPositionRequest] = useState<EditorPositionRequest>();
  const [editorFormatRequestId, setEditorFormatRequestId] = useState<number>();
  const [isEditorSplit, setIsEditorSplit] = useState(false);
  const [splitPath, setSplitPath] = useState<string>();
  const [splitContent, setSplitContent] = useState("");
  const openPaths = editorTabs.openPaths;
  const editorDraftsRef = useRef(editorDrafts);
  const editorTabsRef = useRef(editorTabs);
  const selectedPathRef = useRef(selectedPath);
  const editorContentRef = useRef(editorContent);
  const splitPathRef = useRef(splitPath);
  const splitContentRef = useRef(splitContent);
  const appliedEditorContentRef = useRef(editorContent);
  const appliedSplitContentRef = useRef(splitContent);
  const suppressEditorChangeRef = useRef(0);
  const suppressSplitChangeRef = useRef(0);
  editorDraftsRef.current = editorDrafts;
  editorTabsRef.current = editorTabs;
  selectedPathRef.current = selectedPath;
  editorContentRef.current = editorContent;
  splitPathRef.current = splitPath;
  splitContentRef.current = splitContent;
  const [replaceQuery, setReplaceQuery] = useState("");
  const [editorThemePreference, setEditorThemePreference] = useState<EditorThemePreference>("system");
  const terminal = useProjectTerminalSessions();
  const [error, setError] = useState<string>();
  const [isStarting, setIsStarting] = useState(false);
  const [resumeStatus, setResumeStatus] = useState<string>();
  const [isRunningPreview, setIsRunningPreview] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isServerSaving, setIsServerSaving] = useState(false);
  const [serverSaveStatus, setServerSaveStatus] = useState(INITIAL_SERVER_SAVE_STATUS);
  const [serverSaveFailure, setServerSaveFailure] = useState<"retry" | "stale">();
  const [recoveringAction, setRecoveringAction] = useState<RuntimeRecoveryActionKind>();
  const [confirmingWriterTakeover, setConfirmingWriterTakeover] = useState(false);
  const [isolatedPreviewUrl, setIsolatedPreviewUrl] = useState<string>();
  const [previewHistory, setPreviewHistory] = useState<PreviewHistory>(createPreviewHistory);
  const [previewAddress, setPreviewAddress] = useState("/");
  const previewAddressEditingRef = useRef(false);
  const [previewRefreshFailed, setPreviewRefreshFailed] = useState(false);
  const [editorStatus, setEditorStatus] = useState("로컬 초안");
  const [runtime, setRuntime] = useState<RuntimeViewState>(EMPTY_RUNTIME_STATE);
  const [fileQuery, setFileQuery] = useState("");
  const [fileListLimit, setFileListLimit] = useState(FILE_LIST_BATCH_SIZE);
  const [sidebarPanel, setSidebarPanel] = useState<SidebarPanel>("files");
  const [isQuickOpenOpen, setIsQuickOpenOpen] = useState(false);
  const [quickOpenQuery, setQuickOpenQuery] = useState("");
  const [quickOpenIndex, setQuickOpenIndex] = useState(0);
  const [fileOperation, setFileOperation] = useState<FileOperation>();
  const [fileOperationValue, setFileOperationValue] = useState("");
  const [confirmingFileDelete, setConfirmingFileDelete] = useState(false);
  const [pendingDeletePath, setPendingDeletePath] = useState<string>();
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const [matchFileCase, setMatchFileCase] = useState(false);
  const [useFileRegularExpression, setUseFileRegularExpression] = useState(false);
  const [isPreviewOpen, setIsPreviewOpen] = useState(true);
  const [isTerminalOpen, setIsTerminalOpen] = useState(false);
  isTerminalOpenRef.current = isTerminalOpen;
  const [bottomPanel, setBottomPanel] = useState<BottomPanel>("terminal");
  const [sidebarWidth, setSidebarWidth] = useState(240);
  const [previewWidth, setPreviewWidth] = useState(420);
  const [bottomPanelHeight, setBottomPanelHeight] = useState(192);
  const [isFocusMode, setIsFocusMode] = useState(false);
  const [hasUnpublishedChanges, setHasUnpublishedChanges] = useState(false);
  const [confirmingWorkspaceStop, setConfirmingWorkspaceStop] = useState(false);

  const hasWorkspace = workspace?.status === "ready";
  const hasIsolatedPreview = isolatedPreviewUrl !== undefined;
  const canWriteLocalDraft = runtime.localDraftAccess === "writer";
  const recoveryDiagnostics = runtime.diagnostics.filter((diagnostic) => diagnostic.actions.length > 0);
  const readWorkspaceText = useCallback((path: string) => {
    const pending = editorDraftsRef.current.pending.get(path);
    if (pending !== undefined) return pending;
    return adapterRef.current?.workspace.readText(path) ?? "";
  }, []);
  const explorerFiles = useMemo(
    () => visibleStudioExplorerFiles(workspace?.files ?? EMPTY_WORKSPACE_FILES),
    [workspace]
  );
  const {
    hasMoreFiles,
    matchingFiles,
    visibleFiles
  } = useProjectFileSearch({
    files: explorerFiles,
    limit: fileListLimit,
    matchCase: matchFileCase,
    query: isQuickOpenOpen ? quickOpenQuery : "",
    useRegularExpression: useFileRegularExpression,
    selectedPath
  });
  const {
    isSearchPending: isContentSearchPending,
    matches: contentSearchMatches,
    searchError: contentSearchError,
    totalMatches: totalContentSearchMatches
  } = useProjectContentSearch({
    files: explorerFiles,
    limit: fileListLimit,
    matchCase: matchFileCase,
    query: sidebarPanel === "search" ? fileQuery : "",
    readText: readWorkspaceText,
    selectedContent: editorContent,
    selectedPath,
    useRegularExpression: useFileRegularExpression
  });
  const activeBufferDirty = editorStatus === "저장하지 않은 로컬 변경";
  const hasUnsavedEditorChange = activeBufferDirty || editorDrafts.dirtyPaths.size > 0;
  const selectedFileName = selectedPath?.split("/").at(-1);
  const editorLineCount = editorContent.length === 0 ? 1 : editorContent.split("\n").length;
  useUnsavedChangesGuard(hasUnpublishedChanges || hasUnsavedEditorChange);

  useEffect(() => {
    if (!hasWorkspace) return;
    const nextUrl = new URL(globalThis.location.href);
    if (selectedPath) nextUrl.searchParams.set("file", selectedPath);
    else nextUrl.searchParams.delete("file");
    if (isTerminalOpen && bottomPanel === "terminal") nextUrl.searchParams.set("terminal", "dev");
    else nextUrl.searchParams.delete("terminal");
    globalThis.history.replaceState(globalThis.history.state, "", nextUrl);
  }, [bottomPanel, hasWorkspace, isTerminalOpen, selectedPath]);

  const css = ideStyles({ focus: isFocusMode, previewOpen: isPreviewOpen, sidebarOpen: isSidebarOpen });
  const workbenchLayout = workbenchLayoutClass({
    focusMode: isFocusMode,
    previewOpen: isPreviewOpen,
    sidebarOpen: isSidebarOpen
  });
  const utilityLayout = isSidebarOpen ? undefined : "max-[72rem]:col-span-2";
  const workbenchStyle = {
    "--studio-preview-width": `${previewWidth}px`,
    "--studio-sidebar-width": `${sidebarWidth}px`
  } as CSSProperties;

  const session = createStudioShellSession({
    activeBufferDirty,
    adapterRef,
    appliedEditorContentRef,
    appliedSplitContentRef,
    assetRevision,
    bottomPanel,
    bottomPanelHeight,
    canWriteLocalDraft,
    confirmingFileDelete,
    confirmingWorkspaceStop,
    confirmingWriterTakeover,
    contentSearchError,
    contentSearchMatches,
    css,
    editorContent,
    editorContentRef,
    editorDiagnostics,
    editorDrafts,
    editorDraftsRef,
    editorFormatRequestId,
    editorLineCount,
    editorPositionRequest,
    editorStatus,
    editorTabs,
    editorTabsRef,
    editorThemePreference,
    error,
    explorerFiles,
    fileListLimit,
    fileOperation,
    fileOperationValue,
    fileQuery,
    fileSearchRef,
    hasIsolatedPreview,
    hasMoreFiles,
    hasUnpublishedChanges,
    hasUnsavedEditorChange,
    hasWorkspace,
    isContentSearchPending,
    isEditorSplit,
    isFocusMode,
    isPreviewOpen,
    isRunningPreview,
    isSaving,
    isServerSaving,
    isSidebarOpen,
    isStarting,
    isTerminalOpen,
    isTerminalOpenRef,
    isolatedPreviewUrl,
    manifestAbortRef,
    matchFileCase,
    matchingFiles,
    onProjectCommit,
    onProjectReload,
    openPaths,
    packageSyncGenerationRef,
    pendingDeletePath,
    previewAddress,
    previewAddressEditingRef,
    previewBridgeFactory,
    previewBridgeOperationRef,
    previewBridgeRef,
    previewCancelRequestedRef,
    previewConfiguration,
    previewConsole,
    previewConsoleIdRef,
    previewFrameRef,
    previewHistory,
    previewRecoveryRef,
    previewRefreshFailed,
    previewWidth,
    previewWindowBridgesRef,
    previewWindowDisposersRef,
    previousServerLogsRef,
    project,
    projectEtag,
    quickOpenIndex,
    quickOpenQuery,
    readWorkspaceText,
    recoveringAction,
    recoveryDiagnostics,
    replaceQuery,
    resumeProjectContentLoader,
    resumeStatus,
    runtime,
    runtimeFeatureLoader,
    saveAbortRef,
    selectedFileName,
    selectedPath,
    selectedPathRef,
    serverSaveFailure,
    serverSaveStatus,
    setBottomPanel,
    setBottomPanelHeight,
    setConfirmingFileDelete,
    setConfirmingWorkspaceStop,
    setConfirmingWriterTakeover,
    setEditorContent,
    setEditorDiagnostics,
    setEditorDrafts,
    setEditorFormatRequestId,
    setEditorPositionRequest,
    setEditorStatus,
    setEditorTabs,
    setEditorThemePreference,
    setError,
    setFileListLimit,
    setFileOperation,
    setFileOperationValue,
    setFileQuery,
    setHasUnpublishedChanges,
    setIsEditorSplit,
    setIsFocusMode,
    setIsPreviewOpen,
    setIsRunningPreview,
    setIsSaving,
    setIsServerSaving,
    setIsSidebarOpen,
    setIsStarting,
    setIsTerminalOpen,
    setIsolatedPreviewUrl,
    setMatchFileCase,
    setPendingDeletePath,
    setPreviewAddress,
    setPreviewConsole,
    setPreviewHistory,
    setPreviewRefreshFailed,
    setPreviewWidth,
    setQuickOpenIndex,
    setQuickOpenQuery,
    setRecoveringAction,
    setReplaceQuery,
    setResumeStatus,
    setRuntime,
    setSelectedPath,
    setServerSaveFailure,
    setServerSaveStatus,
    setSidebarPanel,
    setSidebarWidth,
    setSplitContent,
    setSplitPath,
    setUseFileRegularExpression,
    setWorkspace,
    sidebarPanel,
    sidebarWidth,
    splitContent,
    splitContentRef,
    splitPath,
    splitPathRef,
    suppressEditorChangeRef,
    suppressSplitChangeRef,
    terminal,
    totalContentSearchMatches,
    unmountedRef,
    unsubscribeRef,
    useFileRegularExpression,
    utilityLayout,
    visibleFiles,
    workbenchLayout,
    workbenchRef,
    workbenchStyle,
    workspace,
    workspaceScope,
    workspaceStartOperationRef,
    isQuickOpenOpen,
    setIsQuickOpenOpen
  });
  useStudioEditorActions(session);
  useStudioPreview(session);
  bindStudioTerminal(session);
  bindStudioServerSave(session);
  bindStudioWorkspace(session);

  function startWorkspace(): Promise<void> {
    return session.startWorkspace();
  }

  useEffect(() => {
    setEditorThemePreference(readEditorThemePreference());
  }, []);

  useEffect(() => {
    unmountedRef.current = false;
    const initialUrl = new URL(globalThis.location.href);
    if (initialUrl.searchParams.get("terminal") === "dev") {
      setBottomPanel("terminal");
      setIsTerminalOpen(true);
    }
    if (project.state === "active") void startWorkspace();
    return () => {
      unmountedRef.current = true;
      workspaceStartOperationRef.current += 1;
      previewBridgeOperationRef.current += 1;
      manifestAbortRef.current?.abort();
      saveAbortRef.current?.abort();
      unsubscribeRef.current();
      const bridge = previewBridgeRef.current;
      previewBridgeRef.current = undefined;
      for (const dispose of previewWindowDisposersRef.current) dispose();
      previewWindowDisposersRef.current.clear();
      previewWindowBridgesRef.current.clear();
      void bridge?.dispose();
      void adapterRef.current?.dispose();
    };
  }, []);

  useEffect(() => {
    const saveShortcut = (event: KeyboardEvent) => {
      const command = event.metaKey || event.ctrlKey;
      if (command && event.shiftKey && event.key.toLowerCase() === "e") {
        event.preventDefault();
        setSidebarPanel("files");
        setIsSidebarOpen(true);
        setIsQuickOpenOpen(false);
        return;
      }
      if (command && event.shiftKey && event.key.toLowerCase() === "f") {
        event.preventDefault();
        setSidebarPanel("search");
        setIsSidebarOpen(true);
        setIsQuickOpenOpen(false);
        globalThis.requestAnimationFrame(() => fileSearchRef.current?.focus());
        return;
      }
      if (command && !event.shiftKey && !event.altKey && event.key === "\\") {
        event.preventDefault();
        session.toggleSplit();
        return;
      }
      if (command && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void session.saveToServer();
      }
      if (command && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "p") {
        event.preventDefault();
        setQuickOpenQuery("");
        setQuickOpenIndex(0);
        setIsQuickOpenOpen(true);
      }
      if (command && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "b") {
        event.preventDefault();
        setIsSidebarOpen((current) => !current);
      }
      if (command && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "j") {
        event.preventDefault();
        setIsPreviewOpen((current) => !current);
      }
      if (event.ctrlKey && !event.shiftKey && !event.altKey && !event.metaKey && event.key === "`") {
        event.preventDefault();
        setBottomPanel("terminal");
        setIsTerminalOpen((current) => !current);
      }
    };
    globalThis.addEventListener("keydown", saveShortcut);
    return () => globalThis.removeEventListener("keydown", saveShortcut);
  });

  const { deleteSelectedFile, stopWorkspace } = session;
  return (
    <section className={css.shell()} aria-labelledby="project-ide-title">
      <StudioShellHeader session={session} />
      <StudioQuickOpen session={session} />
      {error ? <div className={css.message({ className: "border-danger/30 bg-danger/10 text-danger" })} role="alert"><strong>작업을 완료하지 못했습니다.</strong><span>{error}</span></div> : null}
      <StudioServerSaveFailure session={session} />
      {resumeStatus ? <p className={css.message({ className: "border-primary/20 bg-selected text-foreground" })} role="status" aria-live="polite">{resumeStatus}</p> : null}
      <StudioWorkspaceRecovery session={session} />
      {project.state !== "active" ? <p className="m-3 text-sm text-muted-foreground">보관된 프로젝트는 읽기 전용입니다. 버전과 복구 지점은 계속 확인할 수 있으며, 기록을 변경하거나 워크스페이스를 시작하려면 먼저 프로젝트를 복원하세요.</p> : null}
      {hasWorkspace ? (
        <div className={css.workbench({ className: workbenchLayout })} ref={workbenchRef} style={workbenchStyle}>
          <StudioActivityBar session={session} />
          <StudioFileSidebar session={session} />
          <StudioEditorColumn session={session}>
            <StudioTerminalDock
              consoleActions={<StudioPreviewConsoleActions session={session} />}
              consolePanel={<StudioPreviewConsole session={session} />}
              portList={<StudioPreviewPorts session={session} />}
              session={session}
            />
          </StudioEditorColumn>
          <StudioPreviewPanel session={session} />
        </div>
      ) : <StudioWorkspaceStart session={session} />}
      <ConfirmationDialog
        confirmLabel="파일 삭제"
        description={`${pendingDeletePath ?? selectedPath ?? "선택한 파일"}을 로컬 초안에서 삭제합니다. 서버에 저장하기 전에는 기존 서버 버전에 영향을 주지 않습니다.`}
        open={confirmingFileDelete}
        title="이 파일을 삭제할까요?"
        onCancel={() => { setConfirmingFileDelete(false); setPendingDeletePath(undefined); }}
        onConfirm={deleteSelectedFile}
      />
      <ConfirmationDialog
        confirmLabel="초안을 버리고 종료"
        description="서버에 저장하지 않은 로컬 초안과 편집 중인 내용이 사라집니다. 필요한 변경은 먼저 서버에 저장하세요."
        open={confirmingWorkspaceStop}
        title="브라우저 워크스페이스를 종료할까요?"
        onCancel={() => setConfirmingWorkspaceStop(false)}
        onConfirm={() => void stopWorkspace()}
      />
    </section>
  );
}
