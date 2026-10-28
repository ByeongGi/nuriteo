"use client";

import type { FormEvent, PointerEvent as ReactPointerEvent } from "react";
import { useEffect } from "react";

import { parseEditorThemePreference, writeEditorThemePreference } from "#src/projects/project-editor-theme.ts";
import { planProjectContentReplace } from "#src/projects/studio/content-replace.ts";
import { closeEditorFile, closeSavedEditorTabs, createEditorTabs, forgetEditorDraft, forgetEditorDraftPrefix, noteEditorDraft, openEditorFile, relocateEditorDraft, relocateEditorPath, renameEditorDraft, renameEditorPath, settleEditorDraft } from "#src/projects/studio/editor-tabs.ts";
import type { EditorOpenMode } from "#src/projects/studio/editor-tabs.ts";
import { visibleStudioExplorerFiles } from "#src/projects/studio/explorer-files.ts";
import { PREVIEW_APPLY_DELAY_MS, type FileOperation, type StudioShellSession } from "#src/projects/studio/studio-shell-session.ts";
import type { RuntimeAdapter } from "#src/runtime/runtime-adapter.ts";
import { previewModuleRefreshPath } from "#src/runtime/preview-import-version.ts";

export function useStudioEditorActions(session: StudioShellSession): void {
  const {
    adapterRef,
    appliedEditorContentRef,
    appliedSplitContentRef,
    bottomPanelHeight,
    editorContent,
    editorContentRef,
    editorDrafts,
    editorDraftsRef,
    editorTabsRef,
    fileOperation,
    fileOperationValue,
    fileQuery,
    isEditorSplit,
    matchFileCase,
    packageSyncGenerationRef,
    pendingDeletePath,
    previewWidth,
    replaceQuery,
    runtime,
    selectedPath,
    selectedPathRef,
    setBottomPanelHeight,
    setConfirmingFileDelete,
    setEditorContent,
    setEditorDiagnostics,
    setEditorDrafts,
    setEditorPositionRequest,
    setEditorStatus,
    setEditorTabs,
    setEditorThemePreference,
    setError,
    setFileOperation,
    setFileOperationValue,
    setHasUnpublishedChanges,
    setIsEditorSplit,
    setIsSaving,
    setIsSidebarOpen,
    setPendingDeletePath,
    setPreviewWidth,
    setRuntime,
    setSelectedPath,
    setSidebarPanel,
    setSidebarWidth,
    setSplitContent,
    setSplitPath,
    setWorkspace,
    sidebarWidth,
    splitContent,
    splitPath,
    splitPathRef,
    suppressEditorChangeRef,
    suppressSplitChangeRef,
    unmountedRef,
    useFileRegularExpression,
    workbenchRef,
    workspace
  } = session;
  useEffect(() => {
    if (runtime.localDraftAccess !== "writer" || editorDrafts.pending.size === 0) return;
    const snapshot = [...editorDrafts.pending.entries()];
    const timer = window.setTimeout(() => {
      for (const [path, content] of snapshot) {
        if (editorDraftsRef.current.pending.get(path) !== content) continue;
        void applyDraftChange(path, content);
      }
    }, PREVIEW_APPLY_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [editorDrafts, runtime.localDraftAccess]);
  function readBufferedText(adapter: RuntimeAdapter, path: string): string {
    const pending = editorDraftsRef.current.pending.get(path);
    if (pending !== undefined) return pending;
    return adapter.workspace.readText(path);
  }

  function showEditorText(content: string): void {
    appliedEditorContentRef.current = content;
    const generation = suppressEditorChangeRef.current + 1;
    suppressEditorChangeRef.current = generation;
    setEditorContent(content);
    window.requestAnimationFrame(() => {
      if (suppressEditorChangeRef.current === generation) suppressEditorChangeRef.current = 0;
    });
  }

  function showSplitText(content: string): void {
    appliedSplitContentRef.current = content;
    const generation = suppressSplitChangeRef.current + 1;
    suppressSplitChangeRef.current = generation;
    setSplitContent(content);
    window.requestAnimationFrame(() => {
      if (suppressSplitChangeRef.current === generation) suppressSplitChangeRef.current = 0;
    });
  }

  function noteEditorDraftChange(path: string, content: string): void {
    const next = noteEditorDraft(editorDraftsRef.current, path, content);
    if (next === editorDraftsRef.current) return;
    editorDraftsRef.current = next;
    setEditorDrafts(next);
    const keepPath = splitPathRef.current;
    setEditorTabs((current) => openEditorFile(current, path, "pin", keepPath === undefined ? undefined : { keepPath }));
  }

  function flushPendingDrafts(adapter: RuntimeAdapter): void {
    const entries = [...editorDraftsRef.current.pending.entries()];
    if (entries.length === 0) return;
    let next = adapter.getState();
    for (const [path, content] of entries) {
      next = adapter.workspace.writeText(path, content);
      session.hotUpdatePreviews(path);
      editorDraftsRef.current = settleEditorDraft(editorDraftsRef.current, path, content);
    }
    setRuntime(next);
    setWorkspace(adapter.workspace.getState());
    setEditorDrafts(editorDraftsRef.current);
    if (selectedPathRef.current && !editorDraftsRef.current.dirtyPaths.has(selectedPathRef.current)) {
      setEditorStatus((status) => status === "저장하지 않은 로컬 변경" ? "로컬 초안 저장됨" : status);
    }
  }

  function flushEditorPath(adapter: RuntimeAdapter, path: string): void {
    const content = editorDraftsRef.current.pending.get(path);
    if (content === undefined) return;
    const next = adapter.workspace.writeText(path, content);
    setRuntime(next);
    setWorkspace(adapter.workspace.getState());
    session.hotUpdatePreviews(path);
    editorDraftsRef.current = settleEditorDraft(editorDraftsRef.current, path, content);
    setEditorDrafts(editorDraftsRef.current);
    if (path === selectedPathRef.current) {
      const savedDraftLabel = next.hmrState === "connected" ? ("로컬 초안 저장됨 · HMR 적용됨") : ("로컬 초안 저장됨");
      setEditorStatus((status) => status === "저장하지 않은 로컬 변경" ? (savedDraftLabel) : status);
    }
  }

  function selectFile(path: string, currentWorkspace = workspace, mode: EditorOpenMode = "preview"): void {
    const file = currentWorkspace?.files.find((candidate) => candidate.path === path);
    if (file?.kind !== "text") {
      showEditorText("");
      setSelectedPath(path);
      setError("바이너리 파일과 지원하지 않는 파일은 텍스트 편집기에서 열 수 없습니다.");
      return;
    }
    try {
      const adapter = adapterRef.current;
      if (!adapter) throw new Error("runtime unavailable");
      const keepPath = isEditorSplit ? splitPath : undefined;
      const tabOptions = keepPath === undefined ? undefined : { keepPath };
      if (path === selectedPath) {
        setEditorTabs((current) => openEditorFile(current, path, mode, tabOptions));
        setError(undefined);
        return;
      }
      const previousPath = selectedPath;
      const previousContent = editorContent;
      const wasMirroring = isEditorSplit && splitPath === previousPath && path !== previousPath;
      if (wasMirroring && previousPath) {
        setSplitPath(previousPath);
        showSplitText(previousContent);
      }
      const content = readBufferedText(adapter, path);
      showEditorText(content);
      setSelectedPath(path);
      const nextKeepPath = wasMirroring ? previousPath : keepPath;
      setEditorTabs((current) => openEditorFile(current, path, mode, nextKeepPath === undefined ? undefined : { keepPath: nextKeepPath }));
      setEditorDiagnostics([]);
      setEditorPositionRequest(undefined);
      setError(undefined);
      if (editorDraftsRef.current.dirtyPaths.has(path)) setEditorStatus("저장하지 않은 로컬 변경");
      else setEditorStatus((status) => status === "저장하지 않은 로컬 변경" ? "로컬 초안" : status);
    } catch {
      showEditorText("");
      setSelectedPath(path);
      setError("이 파일을 텍스트로 열 수 없습니다.");
    }
  }

  function handlePrimaryEditorChange(nextValue: string): void {
    if (suppressEditorChangeRef.current !== 0) return;
    if (!selectedPath || nextValue === appliedEditorContentRef.current) return;
    appliedEditorContentRef.current = nextValue;
    setEditorContent(nextValue);
    setEditorStatus("저장하지 않은 로컬 변경");
    setHasUnpublishedChanges(true);
    noteEditorDraftChange(selectedPath, nextValue);
  }

  function handleSplitEditorChange(nextValue: string): void {
    if (!splitPath || suppressSplitChangeRef.current !== 0) return;
    if (splitPath === selectedPath) {
      handlePrimaryEditorChange(nextValue);
      return;
    }
    if (nextValue === appliedSplitContentRef.current) return;
    appliedSplitContentRef.current = nextValue;
    setSplitContent(nextValue);
    setHasUnpublishedChanges(true);
    noteEditorDraftChange(splitPath, nextValue);
  }

  function persistSelectedEditorToDraft(adapter = adapterRef.current): void {
    if (!adapter) return;
    flushPendingDrafts(adapter);
  }

  function persistSplitDraft(adapter = adapterRef.current): void {
    if (!adapter || !splitPath || splitPath === selectedPath) return;
    flushEditorPath(adapter, splitPath);
  }

  function openInSplit(path: string): void {
    const adapter = adapterRef.current;
    const file = workspace?.files.find((candidate) => candidate.path === path);
    if (!adapter || file?.kind !== "text") {
      setError("바이너리 파일과 지원하지 않는 파일은 분할 편집기에서 열 수 없습니다.");
      return;
    }
    try {
      const content = path === selectedPath ? editorContent : readBufferedText(adapter, path);
      setSplitPath(path);
      showSplitText(content);
      setIsEditorSplit(true);
      setEditorTabs((current) => openEditorFile(current, path, "pin", { keepPath: path }));
      setError(undefined);
    } catch {
      setError("이 파일을 분할 편집기에서 열 수 없습니다.");
    }
  }

  function closeSplit(): void {
    persistSplitDraft();
    setIsEditorSplit(false);
    setSplitPath(undefined);
    showSplitText("");
  }

  function toggleSplit(): void {
    if (isEditorSplit) {
      closeSplit();
      return;
    }
    if (!selectedPath) return;
    setSplitPath(selectedPath);
    showSplitText(editorContent);
    setIsEditorSplit(true);
  }

  function copyExplorerPath(path: string): void {
    void navigator.clipboard.writeText(path).catch(() => {
      setError("파일 경로를 복사하지 못했습니다.");
    });
  }

  function beginCreate(directoryPath?: string): void {
    setSidebarPanel("files");
    setIsSidebarOpen(true);
    setFileOperation("create");
    const directory = directoryPath?.replace(/\/$/u, "");
    setFileOperationValue(directory ? `${directory}/` : "src/");
  }

  function beginCreateDirectory(directoryPath?: string): void {
    setSidebarPanel("files");
    setIsSidebarOpen(true);
    setFileOperation("directory");
    const directory = directoryPath?.replace(/\/$/u, "");
    setFileOperationValue(directory ? `${directory}/` : "");
  }

  function beginRename(path: string): void {
    selectFile(path);
    setSidebarPanel("files");
    setIsSidebarOpen(true);
    setFileOperation("rename");
    setFileOperationValue(path);
  }

  function requestDelete(path: string): void {
    const isFile = workspace?.files.some((file) => file.path === path) ?? false;
    if (isFile) selectFile(path);
    setPendingDeletePath(path);
    setConfirmingFileDelete(true);
  }

  async function applyDraftChange(path: string, content: string): Promise<void> {
    const adapter = adapterRef.current;
    if (!adapter || unmountedRef.current) return;
    if (editorDraftsRef.current.pending.get(path) !== content) return;
    try {
      const next = adapter.workspace.writeText(path, content);
      setRuntime(next);
      const workspaceState = adapter.workspace.getState();
      setWorkspace(workspaceState);
      editorDraftsRef.current = settleEditorDraft(editorDraftsRef.current, path, content);
      setEditorDrafts(editorDraftsRef.current);
      const wroteActive = path === selectedPathRef.current && editorContentRef.current === content;
      if (path !== "package.json") {
        session.hotUpdatePreviews(path);
        if (wroteActive) setEditorStatus(next.hmrState === "connected" ? "로컬 초안 저장됨 · HMR 적용됨" : "로컬 초안 저장됨 · 재시작 필요할 수 있음");
        setError(undefined);
        return;
      }
      const generation = ++packageSyncGenerationRef.current;
      if (wroteActive) setEditorStatus("추가한 패키지를 설치하는 중");
      const synced = await adapter.workflow.syncDeclaredPackages();
      if (generation !== packageSyncGenerationRef.current || unmountedRef.current) return;
      const stillActive = path === selectedPathRef.current && editorContentRef.current === content;
      if (synced.added.length > 0) {
        session.hotUpdatePreviews(previewModuleRefreshPath(workspaceState.files.map((file) => file.path)));
        if (stillActive) setEditorStatus("패키지 설치됨 · 미리보기에 반영됨");
      } else {
        session.hotUpdatePreviews(path);
        if (stillActive) setEditorStatus(next.hmrState === "connected" ? "로컬 초안 저장됨 · HMR 적용됨" : "로컬 초안 저장됨 · 재시작 필요할 수 있음");
      }
      setError(undefined);
    } catch {
      if (unmountedRef.current) return;
      setError(path === "package.json" ? "추가한 패키지를 미리보기에 설치하지 못했습니다." : "텍스트 변경사항을 미리보기에 적용하지 못했습니다.");
    }
  }

  function closeFile(path: string): void {
    const adapter = adapterRef.current;
    if (adapter) flushEditorPath(adapter, path);
    const currentIndex = editorTabsRef.current.openPaths.indexOf(path);
    const nextTabs = closeEditorFile(editorTabsRef.current, path);
    setEditorTabs(nextTabs);
    if (path !== selectedPath) return;
    if (isEditorSplit && splitPath === path) {
      showSplitText(editorContent);
    }
    const nextPath = nextTabs.openPaths[Math.min(Math.max(currentIndex, 0), nextTabs.openPaths.length - 1)];
    setEditorDiagnostics([]);
    setEditorPositionRequest(undefined);
    if (nextPath && adapter) {
      const content = readBufferedText(adapter, nextPath);
      showEditorText(content);
      setSelectedPath(nextPath);
      if (editorDraftsRef.current.dirtyPaths.has(nextPath)) setEditorStatus("저장하지 않은 로컬 변경");
      else setEditorStatus((status) => status === "저장하지 않은 로컬 변경" ? "로컬 초안" : status);
      return;
    }
    closeSplit();
    setSelectedPath(undefined);
    showEditorText("");
  }

  function closeAllFiles(): void {
    const adapter = adapterRef.current;
    if (adapter) flushPendingDrafts(adapter);
    setIsEditorSplit(false);
    setSplitPath(undefined);
    showSplitText("");
    setEditorTabs(createEditorTabs());
    setSelectedPath(undefined);
    showEditorText("");
    setEditorDiagnostics([]);
    setEditorPositionRequest(undefined);
  }

  function closeSavedFiles(): void {
    const nextTabs = closeSavedEditorTabs(editorTabsRef.current, editorDraftsRef.current.dirtyPaths);
    setEditorTabs(nextTabs);
    if (splitPath && !nextTabs.openPaths.includes(splitPath)) {
      setIsEditorSplit(false);
      setSplitPath(undefined);
      showSplitText("");
    }
    if (selectedPath && nextTabs.openPaths.includes(selectedPath)) return;
    const nextPath = nextTabs.openPaths.at(-1);
    setEditorDiagnostics([]);
    setEditorPositionRequest(undefined);
    if (!nextPath) {
      setSelectedPath(undefined);
      showEditorText("");
      return;
    }
    const adapter = adapterRef.current;
    const content = adapter ? readBufferedText(adapter, nextPath) : editorDraftsRef.current.pending.get(nextPath) ?? "";
    showEditorText(content);
    setSelectedPath(nextPath);
    if (editorDraftsRef.current.dirtyPaths.has(nextPath)) setEditorStatus("저장하지 않은 로컬 변경");
  }

  function changeEditorThemePreference(value: unknown): void {
    const preference = parseEditorThemePreference(typeof value === "string" ? value : undefined);
    setEditorThemePreference(preference);
    writeEditorThemePreference(preference);
  }

  function beginFileOperation(operation: FileOperation): void {
    setSidebarPanel("files");
    setIsSidebarOpen(true);
    setFileOperation(operation);
    setFileOperationValue(operation === "rename" ? selectedPath ?? "" : "src/");
  }

  function commitFileOperation(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const adapter = adapterRef.current;
    const nextPath = fileOperationValue.trim();
    if (!adapter || !fileOperation || !nextPath) return;
    try {
      persistSelectedEditorToDraft(adapter);
      if (fileOperation === "create" || fileOperation === "directory") {
        const next = fileOperation === "directory"
          ? adapter.workspace.createDirectory(nextPath)
          : adapter.workspace.createText(nextPath);
        setRuntime(next);
        setWorkspace(adapter.workspace.getState());
        setFileOperation(undefined);
        setFileOperationValue("");
        setHasUnpublishedChanges(true);
        if (fileOperation === "directory") return;
        session.hotUpdatePreviews(nextPath, "create");
        selectFile(nextPath, adapter.workspace.getState(), "pin");
        return;
      }
      if (!selectedPath || nextPath === selectedPath) {
        setFileOperation(undefined);
        return;
      }
      const previousPath = selectedPath;
      const next = adapter.workspace.renameText(previousPath, nextPath);
      setRuntime(next);
      setWorkspace(adapter.workspace.getState());
      editorDraftsRef.current = renameEditorDraft(editorDraftsRef.current, previousPath, nextPath);
      setEditorDrafts(editorDraftsRef.current);
      setEditorTabs((current) => renameEditorPath(current, previousPath, nextPath));
      if (splitPath === previousPath) setSplitPath(nextPath);
      setSelectedPath(nextPath);
      setEditorStatus("파일 이름 변경됨 · 로컬 초안");
      setFileOperation(undefined);
      setFileOperationValue("");
      setHasUnpublishedChanges(true);
      session.hotUpdatePreviews(nextPath, "rename");
    } catch {
      const fileOperationError = fileOperation === "directory" ? ("새 폴더를 만들지 못했습니다. 경로와 중복 여부를 확인하세요.") : ("새 파일을 만들지 못했습니다. 경로와 중복 여부를 확인하세요.");
      setError(fileOperation === "rename" ? "파일 이름을 변경하지 못했습니다. 경로와 중복 여부를 확인하세요." : fileOperationError);
    }
  }

  function moveExplorerPath(from: string, targetDirectory: string): void {
    const adapter = adapterRef.current;
    const name = from.split("/").at(-1);
    if (!adapter || !name) return;
    const destination = targetDirectory ? `${targetDirectory}/${name}` : name;
    if (destination === from || destination.startsWith(`${from}/`)) return;
    try {
      const next = adapter.workspace.movePath(from, destination);
      setRuntime(next);
      setWorkspace(adapter.workspace.getState());
      editorDraftsRef.current = relocateEditorDraft(editorDraftsRef.current, from, destination);
      setEditorDrafts(editorDraftsRef.current);
      const nextTabs = relocateEditorPath(editorTabsRef.current, from, destination);
      setEditorTabs(nextTabs);
      if (splitPath && (splitPath === from || splitPath.startsWith(`${from}/`))) {
        setSplitPath(`${destination}${splitPath.slice(from.length)}`);
      }
      if (selectedPath && (selectedPath === from || selectedPath.startsWith(`${from}/`))) {
        setSelectedPath(`${destination}${selectedPath.slice(from.length)}`);
      }
      setEditorStatus("파일을 옮겼습니다 · 로컬 초안");
      setHasUnpublishedChanges(true);
      setError(undefined);
      session.hotUpdatePreviews(destination, "rename");
    } catch {
      setError("파일이나 폴더를 옮기지 못했습니다. 경로와 중복 여부를 확인하세요.");
    }
  }

  function deleteSelectedFile(): void {
    const adapter = adapterRef.current;
    const deletedPath = pendingDeletePath ?? selectedPath;
    if (!adapter || !deletedPath) return;
    const workspaceState = adapter.workspace.getState();
    const isFile = workspaceState.files.some((file) => file.path === deletedPath);
    if (!isFile) {
      try {
        const next = adapter.workspace.deletePath(deletedPath);
        editorDraftsRef.current = forgetEditorDraftPrefix(editorDraftsRef.current, deletedPath);
        setEditorDrafts(editorDraftsRef.current);
        const affected = editorTabsRef.current.openPaths.filter((path) => path === deletedPath || path.startsWith(`${deletedPath}/`));
        let nextTabs = editorTabsRef.current;
        for (const path of affected) nextTabs = closeEditorFile(nextTabs, path);
        const nextPath = selectedPath && (selectedPath === deletedPath || selectedPath.startsWith(`${deletedPath}/`))
          ? nextTabs.openPaths.at(-1)
          : selectedPath;
        setRuntime(next);
        setWorkspace(adapter.workspace.getState());
        setEditorTabs(nextTabs);
        if (splitPath && (splitPath === deletedPath || splitPath.startsWith(`${deletedPath}/`))) {
          setIsEditorSplit(false);
          setSplitPath(undefined);
          showSplitText("");
        }
        setSelectedPath(nextPath);
        showEditorText(nextPath ? readBufferedText(adapter, nextPath) : "");
        setEditorDiagnostics([]);
        setEditorPositionRequest(undefined);
        setEditorStatus("폴더 삭제됨 · 로컬 초안");
        setHasUnpublishedChanges(true);
        setConfirmingFileDelete(false);
        setPendingDeletePath(undefined);
        session.hotUpdatePreviews(deletedPath, "delete");
      } catch {
        setConfirmingFileDelete(false);
        setError("폴더를 삭제하지 못했습니다.");
      }
      return;
    }
    try {
      const next = adapter.workspace.deleteText(deletedPath);
      editorDraftsRef.current = forgetEditorDraft(editorDraftsRef.current, deletedPath);
      setEditorDrafts(editorDraftsRef.current);
      const nextTabs = closeEditorFile(editorTabsRef.current, deletedPath);
      const nextPath = nextTabs.openPaths.at(-1);
      setRuntime(next);
      setWorkspace(adapter.workspace.getState());
      setEditorTabs(nextTabs);
      if (splitPath === deletedPath) {
        setIsEditorSplit(false);
        setSplitPath(undefined);
        showSplitText("");
      }
      setSelectedPath(nextPath);
      showEditorText(nextPath ? readBufferedText(adapter, nextPath) : "");
      setEditorDiagnostics([]);
      setEditorPositionRequest(undefined);
      setEditorStatus("파일 삭제됨 · 로컬 초안");
      setHasUnpublishedChanges(true);
      setConfirmingFileDelete(false);
      setPendingDeletePath(undefined);
      session.hotUpdatePreviews(deletedPath, "delete");
    } catch {
      setConfirmingFileDelete(false);
      setError("파일을 삭제하지 못했습니다.");
    }
  }

  function beginHorizontalResize(panel: "files" | "preview", event: ReactPointerEvent<HTMLDivElement>): void {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = panel === "files" ? sidebarWidth : previewWidth;
    const workbenchWidth = workbenchRef.current?.clientWidth ?? globalThis.innerWidth;
    const move = (moveEvent: PointerEvent) => {
      const delta = moveEvent.clientX - startX;
      if (panel === "files") {
        setSidebarWidth(Math.max(192, Math.min(360, startWidth + delta)));
        return;
      }
      const maximumPreviewWidth = Math.max(320, workbenchWidth - sidebarWidth - 48 - 480);
      setPreviewWidth(Math.max(320, Math.min(maximumPreviewWidth, startWidth - delta)));
    };
    const stop = () => {
      globalThis.removeEventListener("pointermove", move);
      globalThis.removeEventListener("pointerup", stop);
    };
    globalThis.addEventListener("pointermove", move);
    globalThis.addEventListener("pointerup", stop, { once: true });
  }

  function beginBottomPanelResize(event: ReactPointerEvent<HTMLDivElement>): void {
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = bottomPanelHeight;
    const move = (moveEvent: PointerEvent) => setBottomPanelHeight(Math.max(120, Math.min(480, startHeight + startY - moveEvent.clientY)));
    const stop = () => {
      globalThis.removeEventListener("pointermove", move);
      globalThis.removeEventListener("pointerup", stop);
    };
    globalThis.addEventListener("pointermove", move);
    globalThis.addEventListener("pointerup", stop, { once: true });
  }

  function saveSelectedFile() {
    const adapter = adapterRef.current;
    if (!adapter || !selectedPath) return;
    setError(undefined);
    setIsSaving(true);
    try {
      const next = adapter.workspace.writeText(selectedPath, editorContent);
      setRuntime(next);
      setWorkspace(adapter.workspace.getState());
      session.hotUpdatePreviews(selectedPath);
      editorDraftsRef.current = settleEditorDraft(editorDraftsRef.current, selectedPath, editorContent);
      setEditorDrafts(editorDraftsRef.current);
      setEditorStatus(next.hmrState === "connected" ? "로컬 초안 저장됨 · HMR 적용됨" : "로컬 초안 저장됨 · 재시작 필요할 수 있음");
    } catch {
      setError("텍스트 변경사항을 안전하게 저장하지 못했습니다.");
    } finally {
      setIsSaving(false);
    }
  }

  function replaceInProject(): void {
    const adapter = adapterRef.current;
    if (!adapter || runtime.localDraftAccess !== "writer" || fileQuery.length === 0) return;
    persistSelectedEditorToDraft(adapter);
    persistSplitDraft(adapter);
    const plan = planProjectContentReplace({
      files: visibleStudioExplorerFiles(adapter.workspace.getState().files),
      matchCase: matchFileCase,
      query: fileQuery,
      readText: (path) => {
        if (path === selectedPath) return editorContent;
        if (path === splitPath && path !== selectedPath) return splitContent;
        return adapter.workspace.readText(path);
      },
      replacement: replaceQuery,
      selectedContent: editorContent,
      selectedPath,
      useRegularExpression: useFileRegularExpression
    });
    if (plan.error) {
      setError(plan.error);
      return;
    }
    if (plan.updates.length === 0) {
      setError("바꿀 코드가 없습니다.");
      return;
    }
    try {
      let next = adapter.getState();
      for (const update of plan.updates) {
        next = adapter.workspace.writeText(update.path, update.content);
        session.hotUpdatePreviews(update.path);
      }
      setRuntime(next);
      setWorkspace(adapter.workspace.getState());
      const selectedUpdate = plan.updates.find((update) => update.path === selectedPath);
      if (selectedUpdate) showEditorText(selectedUpdate.content);
      const splitUpdate = plan.updates.find((update) => update.path === splitPath);
      if (splitUpdate && splitPath !== selectedPath) {
        showSplitText(splitUpdate.content);
      }
      for (const update of plan.updates) editorDraftsRef.current = forgetEditorDraft(editorDraftsRef.current, update.path);
      setEditorDrafts(editorDraftsRef.current);
      const count = plan.updates.reduce((total, update) => total + update.replacements, 0);
      setEditorStatus(next.hmrState === "connected" ? `${count}곳을 바꿨습니다 · HMR 적용됨` : `${count}곳을 로컬 초안에서 바꿨습니다`);
      setHasUnpublishedChanges(true);
      setError(undefined);
    } catch {
      setError("코드 바꾸기를 완료하지 못했습니다.");
    }
  }
  session.readBufferedText = readBufferedText;
  session.showEditorText = showEditorText;
  session.showSplitText = showSplitText;
  session.noteEditorDraftChange = noteEditorDraftChange;
  session.flushPendingDrafts = flushPendingDrafts;
  session.flushEditorPath = flushEditorPath;
  session.selectFile = selectFile;
  session.handlePrimaryEditorChange = handlePrimaryEditorChange;
  session.handleSplitEditorChange = handleSplitEditorChange;
  session.persistSelectedEditorToDraft = persistSelectedEditorToDraft;
  session.persistSplitDraft = persistSplitDraft;
  session.openInSplit = openInSplit;
  session.closeSplit = closeSplit;
  session.toggleSplit = toggleSplit;
  session.copyExplorerPath = copyExplorerPath;
  session.beginCreate = beginCreate;
  session.beginCreateDirectory = beginCreateDirectory;
  session.beginRename = beginRename;
  session.requestDelete = requestDelete;
  session.applyDraftChange = applyDraftChange;
  session.closeFile = closeFile;
  session.closeAllFiles = closeAllFiles;
  session.closeSavedFiles = closeSavedFiles;
  session.changeEditorThemePreference = changeEditorThemePreference;
  session.beginFileOperation = beginFileOperation;
  session.commitFileOperation = commitFileOperation;
  session.moveExplorerPath = moveExplorerPath;
  session.deleteSelectedFile = deleteSelectedFile;
  session.beginHorizontalResize = beginHorizontalResize;
  session.beginBottomPanelResize = beginBottomPanelResize;
  session.saveSelectedFile = saveSelectedFile;
  session.replaceInProject = replaceInProject;
}
