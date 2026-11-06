"use client";

import dynamic from "next/dynamic";
import type { ReactNode } from "react";

import { Button } from "#src/components/ui/button.tsx";
import { Input } from "#src/components/ui/input.tsx";
import { MenuGroupLabel, MenuItem, MenuPopup, MenuPortal, MenuPositioner, MenuRadioGroup, MenuRadioItem, MenuRadioItemIndicator, MenuRoot, MenuSeparator, MenuTrigger } from "#src/components/ui/menu.tsx";
import { SearchField } from "#src/components/ui/search-field.tsx";
import { EDITOR_THEME_OPTIONS } from "@/projects/_utils/project-editor-theme.ts";
import { ProjectFileTree } from "@/projects/_components/project-file-tree.tsx";
import { runtimeDot } from "@/projects/studio/_components/studio-ide-styles.ts";
import { FILE_LIST_BATCH_SIZE, type StudioShellSession } from "@/projects/studio/_utils/studio-shell-session.ts";
import { runtimeLifecycleLabel } from "@/projects/studio/_utils/studio-shell-labels.ts";

const ProjectMonacoEditor = dynamic(
  () => import("@/projects/_components/project-monaco-editor.tsx").then((module) => module.ProjectMonacoEditor),
  {
    loading: () => <div className="grid h-full min-h-0 place-items-center bg-surface text-xs text-muted-foreground" role="status">코드 편집기를 준비하는 중…</div>,
    ssr: false
  }
);

function EditorBreadcrumbs({ className, path }: Readonly<{ className: string; path: string }>) {
  const parts = path.split("/");
  return <nav aria-label="파일 경로" className={className}>{parts.map((part, index) => {
    const crumb = parts.slice(0, index + 1).join("/");
    const isFile = index === parts.length - 1;
    return <span className="flex min-w-0 items-center gap-1" key={crumb}>{index > 0 ? <span aria-hidden="true">/</span> : null}<span className={isFile ? "truncate text-foreground" : "truncate"}>{part}</span></span>;
  })}</nav>;
}

export function StudioShellHeader({ session }: { readonly session: StudioShellSession }) {
  const {
    canWriteLocalDraft,
    css,
    hasUnpublishedChanges,
    hasUnsavedEditorChange,
    hasWorkspace,
    isFocusMode,
    isPreviewOpen,
    isServerSaving,
    isTerminalOpen,
    project,
    projectEtag,
    runtime,
    saveToServer,
    serverSaveStatus,
    setConfirmingWorkspaceStop,
    setIsFocusMode,
    setIsPreviewOpen,
    setIsTerminalOpen,
    stopWorkspace
  } = session;
  const serverSaveLabel = isServerSaving ? ("저장 중…") : ("서버에 저장");
  const focusModeLabel = isFocusMode ? ("패널 표시") : ("집중 모드");
  const unsavedEditorClass = hasUnsavedEditorChange ? ("is-dirty") : ("");
  const workspaceAccessLabel = canWriteLocalDraft ? ("편집 가능") : ("읽기 전용");
  return (
      <header className={css.header()}>
        <div className={css.identity()}>
          <span className={runtimeDot({ state: runtime.lifecycle === "ready" || runtime.lifecycle === "failed" ? runtime.lifecycle : "idle" })} aria-hidden="true" />
          <div className={css.identityCopy()}>
            <p>개발 워크스페이스</p>
            <div className={css.runtimeMeta()}>
              <span>{runtimeLifecycleLabel(runtime.lifecycle)}</span>
              {hasWorkspace ? <span className={css.access()}>{workspaceAccessLabel}</span> : null}
            </div>
          </div>
          <h3 className="sr-only" id="project-ide-title">{project.name} 개발 편집기</h3>
        </div>
        {hasWorkspace ? <div className={css.headerActions()}>
          <span className={css.saveState()} role="status" aria-live="polite"><i className={unsavedEditorClass} aria-hidden="true" />{serverSaveStatus}</span>
          <Button type="button" size="sm" aria-pressed={isPreviewOpen} onClick={() => setIsPreviewOpen((current) => !current)}>미리보기</Button>
          <Button type="button" size="sm" aria-pressed={isTerminalOpen} onClick={() => setIsTerminalOpen((current) => !current)}>하단 패널</Button>
          <Button type="button" size="sm" aria-pressed={isFocusMode} onClick={() => setIsFocusMode((current) => !current)}>{focusModeLabel}</Button>
          <Button aria-label="서버에 저장" type="button" size="sm" variant="primary" disabled={isServerSaving || !projectEtag || !canWriteLocalDraft} onClick={() => void saveToServer()}>{serverSaveLabel}<kbd>⌘S</kbd></Button>
          <Button aria-label="워크스페이스 종료" type="button" size="sm" onClick={() => {
            if (hasUnpublishedChanges || hasUnsavedEditorChange) setConfirmingWorkspaceStop(true);
            else void stopWorkspace();
          }}>종료</Button>
        </div> : null}
      </header>
  );
}

export function StudioQuickOpen({ session }: { readonly session: StudioShellSession }) {
  const {
    css,
    isQuickOpenOpen,
    matchingFiles,
    project,
    quickOpenIndex,
    quickOpenQuery,
    selectFile,
    setIsQuickOpenOpen,
    setQuickOpenIndex,
    setQuickOpenQuery
  } = session;
  return (
    <>
      {isQuickOpenOpen ? <section className={css.quickOpen()} aria-label="빠른 파일 열기"><label className="sr-only" htmlFor={`quick-open-${project.id}`}>빠른 파일 열기</label><Input id={`quick-open-${project.id}`} autoFocus value={quickOpenQuery} placeholder="파일 이름을 입력하세요" onChange={(event) => { setQuickOpenQuery(event.currentTarget.value); setQuickOpenIndex(0); }} onKeyDown={(event) => {
        const resultCount = Math.min(matchingFiles.length, 40);
        if (event.key === "Escape") setIsQuickOpenOpen(false);
        if (event.key === "ArrowDown" && resultCount > 0) { event.preventDefault(); setQuickOpenIndex((current) => (current + 1) % resultCount); }
        if (event.key === "ArrowUp" && resultCount > 0) { event.preventDefault(); setQuickOpenIndex((current) => (current - 1 + resultCount) % resultCount); }
        if (event.key === "Enter" && matchingFiles[quickOpenIndex]) { selectFile(matchingFiles[quickOpenIndex].path); setIsQuickOpenOpen(false); }
      }} /><ul>{matchingFiles.slice(0, 40).map((file, index) => <li key={file.path}><Button type="button" size="sm" variant="ghost" aria-selected={index === quickOpenIndex} onMouseEnter={() => setQuickOpenIndex(index)} onClick={() => { selectFile(file.path); setIsQuickOpenOpen(false); }}><strong>{file.name}</strong><small>{file.path}</small></Button></li>)}</ul></section> : null}
    </>
  );
}

export function StudioActivityBar({ session }: { readonly session: StudioShellSession }) {
  const {
    css,
    fileSearchRef,
    isFocusMode,
    isSidebarOpen,
    setFileListLimit,
    setIsFocusMode,
    setIsSidebarOpen,
    setSidebarPanel,
    sidebarPanel
  } = session;
  const focusEditorLabel = isFocusMode ? ("전체 패널 표시") : ("편집기에 집중");
  return (
          <aside className={css.activity()} aria-label="Studio 도구">
            <Button
              className={css.activityButton()}
              type="button"
              size="icon"
              variant="ghost"
              aria-label="프로젝트 파일"
              aria-pressed={isSidebarOpen && sidebarPanel === "files"}
              onClick={() => {
                setIsSidebarOpen((current) => {
                  if (sidebarPanel === "files") return (!current);
                  return (true);
                });
                setSidebarPanel("files");
                setFileListLimit(FILE_LIST_BATCH_SIZE);
              }}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M3.5 5.5h6l2 2h9v12h-17z"/><path d="M3.5 9.5h17"/></svg>
            </Button>
            <Button
              className={css.activityButton()}
              type="button"
              size="icon"
              variant="ghost"
              aria-label="프로젝트 파일 검색"
              aria-pressed={isSidebarOpen && sidebarPanel === "search"}
              onClick={() => {
                setIsSidebarOpen((current) => {
                  if (sidebarPanel === "search") return (!current);
                  return (true);
                });
                setSidebarPanel("search");
                setFileListLimit(FILE_LIST_BATCH_SIZE);
                globalThis.requestAnimationFrame(() => fileSearchRef.current?.focus());
              }}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><circle cx="10.5" cy="10.5" r="5.5"/><path d="m15 15 5 5"/></svg>
            </Button>
            <span className={css.activityDivider()} aria-hidden="true" />
            <Button
              className={css.activityButton()}
              type="button"
              size="icon"
              variant="ghost"
              aria-label={focusEditorLabel}
              aria-pressed={isFocusMode}
              onClick={() => setIsFocusMode((current) => !current)}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M4 8V4h4M16 4h4v4M20 16v4h-4M8 20H4v-4"/></svg>
            </Button>
          </aside>
  );
}

export function StudioFileSidebar({ session }: { readonly session: StudioShellSession }) {
  const {
    beginCreate,
    beginCreateDirectory,
    beginFileOperation,
    beginHorizontalResize,
    beginRename,
    canWriteLocalDraft,
    commitFileOperation,
    contentSearchError,
    contentSearchMatches,
    copyExplorerPath,
    css,
    editorDrafts,
    explorerFiles,
    fileOperation,
    fileOperationValue,
    fileQuery,
    fileSearchRef,
    hasMoreFiles,
    isContentSearchPending,
    matchFileCase,
    matchingFiles,
    moveExplorerPath,
    openInSplit,
    project,
    replaceInProject,
    replaceQuery,
    requestDelete,
    selectFile,
    selectedPath,
    setConfirmingFileDelete,
    setEditorPositionRequest,
    setFileListLimit,
    setFileOperation,
    setFileOperationValue,
    setFileQuery,
    setMatchFileCase,
    setPendingDeletePath,
    setReplaceQuery,
    setUseFileRegularExpression,
    sidebarPanel,
    sidebarWidth,
    totalContentSearchMatches,
    useFileRegularExpression,
    visibleFiles,
    workspace
  } = session;
  function moreFilesButton() {
    if (hasMoreFiles) return (<Button className={css.fileMore()} variant="ghost" type="button" onClick={() => setFileListLimit((current) => current + FILE_LIST_BATCH_SIZE)}>다음 {Math.min(FILE_LIST_BATCH_SIZE, matchingFiles.length - visibleFiles.length)}개 보기</Button>);
    return (null);
  }
  function projectFileTree() {
    if (visibleFiles.length > 0 || (workspace?.directories.length ?? 0) > 0) return (<ProjectFileTree canWrite={canWriteLocalDraft} directories={workspace?.directories ?? []} dirtyPaths={editorDrafts.dirtyPaths} files={visibleFiles} onCopyPath={copyExplorerPath} onCreateDirectory={beginCreateDirectory} onCreateInDirectory={beginCreate} onDelete={requestDelete} onMove={moveExplorerPath} onOpenInSplit={openInSplit} onPin={(path) => selectFile(path, workspace, "pin")} onRename={beginRename} onSelect={selectFile} selectedPath={selectedPath} />);
    return (<p className={css.fileEmpty()}>프로젝트 파일이 없습니다.</p>);
  }
  function moreContentResults() {
    if (contentSearchMatches.length < totalContentSearchMatches) return (<Button className={css.fileMore()} variant="ghost" type="button" onClick={() => setFileListLimit((current) => current + FILE_LIST_BATCH_SIZE)}>검색 결과 더 보기</Button>);
    return (null);
  }
  const contentSearchEmptyLabel = fileQuery.trim() ? ("일치하는 코드를 찾지 못했습니다.") : ("검색어를 입력하면 프로젝트 전체 코드를 찾습니다.");
  function contentSearchResults() {
    if (contentSearchMatches.length > 0) return (<ul>{contentSearchMatches.map((match, index) => <li key={`${match.path}:${match.line}:${match.column}:${index}`}><Button type="button" size="sm" variant="ghost" onClick={() => { selectFile(match.path); setEditorPositionRequest({ column: match.column, line: match.line, requestId: Date.now() }); }}><strong>{match.path}</strong><small>{match.line}:{match.column}</small><span>{match.snippet || "빈 줄"}</span></Button></li>)}</ul>);
    return (<p className={css.fileEmpty()}>{contentSearchEmptyLabel}</p>);
  }
  function contentSearchPanel() {
    if (sidebarPanel === "search") return (<div className={css.contentResults()}>
              {contentSearchResults()}
              {moreContentResults()}
            </div>);
    return (<div className={css.fileList()}>
              {projectFileTree()}
              {moreFilesButton()}
            </div>);
  }
  const sidebarCountLabel = sidebarPanel === "search" ? (contentSearchError ?? `${totalContentSearchMatches}개 코드 검색 결과`) : (`파일 ${explorerFiles.length}개`);
  function fileSearchPanel() {
    if (sidebarPanel === "search") return ((
              <div className={css.searchArea()}>
                <SearchField className={css.fileSearch()} label="코드 검색" aria-busy={isContentSearchPending} aria-invalid={contentSearchError !== undefined} ref={fileSearchRef} value={fileQuery} onChange={(event) => { setFileQuery(event.currentTarget.value); setFileListLimit(FILE_LIST_BATCH_SIZE); }} placeholder="프로젝트 코드 검색" autoComplete="off" />
                <div className={css.searchControls()} aria-label="파일 검색 옵션">
                  <Button type="button" size="icon" variant="ghost" aria-label="대소문자 구분" aria-pressed={matchFileCase} onClick={() => setMatchFileCase((current) => !current)}>Aa</Button>
                  <Button type="button" size="icon" variant="ghost" aria-label="정규식 사용" aria-pressed={useFileRegularExpression} onClick={() => setUseFileRegularExpression((current) => !current)}>.*</Button>
                </div>
                <form className={css.replaceRow()} onSubmit={(event) => { event.preventDefault(); replaceInProject(); }}>
                  <Input aria-label="바꿀 내용" value={replaceQuery} onChange={(event) => setReplaceQuery(event.currentTarget.value)} placeholder="바꿀 내용" autoComplete="off" />
                  <Button type="submit" size="sm" disabled={!canWriteLocalDraft || fileQuery.length === 0 || totalContentSearchMatches === 0}>모두 바꾸기</Button>
                </form>
              </div>
            ));
    return (<span aria-hidden="true" />);
  }
  const fileOperationSubmitLabel = fileOperation === "rename" ? ("변경") : ("생성");
  const directoryPathLabel = fileOperation === "directory" ? ("새 폴더 경로") : ("변경할 파일 경로");
  const createFilePathLabel = fileOperation === "create" ? ("새 파일 경로") : (directoryPathLabel);
  function fileOperationForm() {
    if (fileOperation) return (<form className={css.fileOperation()} onSubmit={commitFileOperation}><label className="sr-only" htmlFor={`file-operation-${project.id}`}>{createFilePathLabel}</label><Input id={`file-operation-${project.id}`} autoFocus value={fileOperationValue} onChange={(event) => setFileOperationValue(event.currentTarget.value)} onKeyDown={(event) => { if (event.key === "Escape") setFileOperation(undefined); }} /><Button type="submit" size="sm">{fileOperationSubmitLabel}</Button></form>);
    return (fileSearchPanel());
  }
  const sidebarHeading = sidebarPanel === "search" ? ("코드 검색") : ("파일");
  const sidebarEyebrow = sidebarPanel === "search" ? ("검색") : ("프로젝트");
  return (
          <nav className={css.files()} aria-label="프로젝트 파일">
            <div className="absolute inset-y-0 right-[-0.25rem] z-20 w-2 cursor-col-resize touch-none max-[72rem]:hidden" role="separator" aria-label="파일 패널 너비 조절" aria-orientation="vertical" aria-valuemin={192} aria-valuemax={360} aria-valuenow={sidebarWidth} onPointerDown={(event) => beginHorizontalResize("files", event)} />
            <div className={css.projectSummary()}>
              <strong>{project.name}</strong>
              <span>{project.slug} · v{project.version}</span>
            </div>
            <div className={css.panelHeading()}>
              <div>
                <span>{sidebarEyebrow}</span>
                <strong>{sidebarHeading}</strong>
              </div>
              <div className={css.fileActions()}>
                <Button type="button" size="icon" variant="ghost" aria-label="새 파일" title="새 파일" disabled={!canWriteLocalDraft} onClick={() => beginCreate()}>＋</Button>
                <Button type="button" size="icon" variant="ghost" aria-label="새 폴더" title="새 폴더" disabled={!canWriteLocalDraft} onClick={() => beginCreateDirectory()}>▣</Button>
                <Button type="button" size="icon" variant="ghost" aria-label="선택한 파일 이름 변경" title="이름 변경" disabled={!selectedPath || !canWriteLocalDraft} onClick={() => beginFileOperation("rename")}>✎</Button>
                <Button type="button" size="icon" variant="ghost" aria-label="선택한 파일 삭제" title="삭제" disabled={!selectedPath || !canWriteLocalDraft} onClick={() => { setPendingDeletePath(selectedPath); setConfirmingFileDelete(true); }}>⌫</Button>
                <kbd>⌘P</kbd>
              </div>
            </div>
            {fileOperationForm()}
            <p className={css.fileCount()} aria-live="polite">
              {sidebarCountLabel}
            </p>
            {contentSearchPanel()}
          </nav>
  );
}

export function StudioEditorColumn({ children, session }: { readonly children: ReactNode; readonly session: StudioShellSession }) {
  const {
    activeBufferDirty,
    canWriteLocalDraft,
    changeEditorThemePreference,
    closeAllFiles,
    closeFile,
    closeSavedFiles,
    closeSplit,
    css,
    editorContent,
    editorDrafts,
    editorFormatRequestId,
    editorLineCount,
    editorPositionRequest,
    editorStatus,
    editorTabs,
    editorThemePreference,
    handlePrimaryEditorChange,
    handleSplitEditorChange,
    isEditorSplit,
    isSaving,
    openPaths,
    project,
    readWorkspaceText,
    saveSelectedFile,
    selectFile,
    selectedPath,
    setEditorDiagnostics,
    setEditorFormatRequestId,
    splitContent,
    splitPath,
    toggleSplit,
    workspace,
    workspaceScope
  } = session;
  const applyDraftLabel = isSaving ? ("적용 중…") : ("로컬 초안에 적용");
  const activeBufferClass = activeBufferDirty ? ("is-dirty") : ("");
  const splitEditorValue = splitPath === selectedPath ? (editorContent) : (splitContent);
  function splitEditorPane() {
    if (isEditorSplit && splitPath) return (<div className={css.splitPane()}><div className={css.splitPaneBar()}><span title={splitPath}>{splitPath}</span><Button type="button" size="icon" variant="ghost" aria-label="분할 편집기 닫기" onClick={closeSplit}>×</Button></div><ProjectMonacoEditor path={splitPath} projectKey={`${workspaceScope}:${project.id}`} readOnly={!canWriteLocalDraft} themePreference={editorThemePreference} value={splitEditorValue} onChange={handleSplitEditorChange} /></div>);
    return (null);
  }
  const editorPriorityPaths = splitPath ? ([...openPaths, splitPath]) : (openPaths);
  function editorSurface() {
    if (selectedPath) return (<div className={css.editorHost()}><div className={css.editorPanes()} data-split={isEditorSplit}><ProjectMonacoEditor formatRequestId={editorFormatRequestId} path={selectedPath} priorityPaths={editorPriorityPaths} projectKey={`${workspaceScope}:${project.id}`} readOnly={!canWriteLocalDraft} readWorkspaceText={readWorkspaceText} revealPosition={editorPositionRequest} themePreference={editorThemePreference} value={editorContent} workspaceFiles={workspace?.files} onDiagnosticsChange={setEditorDiagnostics} onChange={handlePrimaryEditorChange} />{splitEditorPane()}</div></div>);
    return (<div className={css.editorEmpty()}><span aria-hidden="true">⌘</span><strong>편집할 파일을 선택하세요</strong><p>왼쪽 파일 목록에서 선택하거나 <kbd>⌘P</kbd>로 빠르게 찾을 수 있습니다.</p></div>);
  }
  function editorBreadcrumbs() {
    if (selectedPath) return (<EditorBreadcrumbs className={css.editorBreadcrumbs()} path={selectedPath} />);
    return (null);
  }
  const splitEditorLabel = isEditorSplit ? ("편집기 분할 닫기") : ("편집기 분할");
  function editorTabList() {
    if (openPaths.length > 0) return (openPaths.map((path) => {
                  const fileName = path.split("/").at(-1) ?? path;
                  const isActive = path === selectedPath;
                  const isPreview = editorTabs.previewPath === path && !editorTabs.pinnedPaths.has(path);
          const previewTabClass = isPreview ? ("is-preview") : ("");
          const activeTabClass = isActive ? ("is-active") : ("");
                  const tabClass = [activeTabClass, previewTabClass].filter(Boolean).join(" ") || undefined;
          function dirtyTabMarker() {
            if (editorDrafts.dirtyPaths.has(path)) return (<i className="is-dirty" aria-label="저장하지 않은 변경 사항" />);
            return (null);
          }
          const editorTabTitle = isPreview ? (`${path} · 미리보기`) : (path);
                  return <div className={tabClass} key={path}>
                    <Button className="tab-select" type="button" size="sm" variant="ghost" aria-pressed={isActive} title={editorTabTitle} onClick={() => selectFile(path, workspace, "activate")} onDoubleClick={() => selectFile(path, workspace, "pin")}><span className={css.fileIcon()} aria-hidden="true">#</span><strong>{fileName}</strong>{dirtyTabMarker()}</Button>
                    <Button className="tab-close" type="button" size="icon" variant="ghost" aria-label={`${fileName} 닫기`} onClick={() => closeFile(path)}>×</Button>
                  </div>;
                }));
    return (<span>파일을 선택하세요</span>);
  }
  const textEditorOpen = selectedPath ? (true) : (undefined);
  return (
          <div className={css.editorStack()}>
            <section className={css.editor()} aria-label="텍스트 편집기" data-path={textEditorOpen}>
              <div className={css.editorTabs()} role="toolbar" aria-label="열린 파일">
                {editorTabList()}
                <div className="sticky right-0 ml-auto !max-w-none !gap-0 !border-l !border-r-0 !border-muted-border bg-subtle !px-1" role="group" aria-label="편집기 작업">
                  <Button className="grid size-7 place-items-center rounded-sm border-0 bg-transparent text-muted-foreground hover:bg-hover hover:text-foreground" type="button" size="icon" variant="ghost" aria-label="문서 서식 정리" disabled={!selectedPath || !canWriteLocalDraft} onClick={() => setEditorFormatRequestId(Date.now())}>↹</Button>
                  <Button className="grid size-7 place-items-center rounded-sm border-0 bg-transparent text-muted-foreground hover:bg-hover hover:text-foreground" type="button" size="icon" variant="ghost" aria-label={splitEditorLabel} disabled={!selectedPath} onClick={toggleSplit}>◫</Button>
                  <MenuRoot>
                    <MenuTrigger className="grid size-7 place-items-center rounded-sm border-0 bg-transparent text-muted-foreground hover:bg-hover hover:text-foreground" type="button" aria-label="편집기 작업 더 보기">•••</MenuTrigger>
                    <MenuPortal>
                      <MenuPositioner align="end" side="bottom" sideOffset={4}>
                        <MenuPopup className="w-56 text-xs">
                          <MenuRadioGroup value={editorThemePreference} onValueChange={changeEditorThemePreference}>
                            <MenuGroupLabel>에디터 테마</MenuGroupLabel>
                            {EDITOR_THEME_OPTIONS.map((option) => (
                              <MenuRadioItem closeOnClick key={option.value} value={option.value}>
                                <MenuRadioItemIndicator className="data-[unchecked]:invisible" keepMounted aria-hidden="true">✓</MenuRadioItemIndicator>
                                <span>{option.label}</span>
                              </MenuRadioItem>
                            ))}
                          </MenuRadioGroup>
                          <MenuSeparator />
                          <MenuItem disabled={openPaths.length === 0} onClick={closeSavedFiles}><span aria-hidden="true" /><span>저장된 편집기 닫기</span></MenuItem>
                          <MenuItem disabled={openPaths.length === 0} onClick={closeAllFiles}><span aria-hidden="true" /><span>모든 편집기 닫기</span></MenuItem>
                        </MenuPopup>
                      </MenuPositioner>
                    </MenuPortal>
                  </MenuRoot>
                </div>
              </div>
              {editorBreadcrumbs()}
              {editorSurface()}
              <div className={css.status()}><span><i className={activeBufferClass} aria-hidden="true" />{editorStatus}</span><span>{editorLineCount}줄 · {editorContent.length}자 · UTF-8</span><Button aria-label="로컬 초안에 적용" type="button" size="sm" disabled={!selectedPath || isSaving || !canWriteLocalDraft} onClick={saveSelectedFile}>{applyDraftLabel}</Button></div>
            </section>
            {children}
          </div>
  );
}

