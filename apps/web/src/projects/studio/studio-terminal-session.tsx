"use client";

import type { ReactNode } from "react";

import { Button } from "#src/components/ui/button.tsx";
import { ProjectTerminalView } from "#src/projects/project-terminal-view.tsx";
import { closeEditorFile, forgetEditorDraft, openEditorFile, renameEditorDraft, renameEditorPath } from "#src/projects/studio/editor-tabs.ts";
import { MAX_TERMINAL_COMMAND_CHARS, type StudioShellSession } from "#src/projects/studio/studio-shell-session.ts";
import { previewModuleRefreshPath } from "#src/runtime/preview-import-version.ts";

export function bindStudioTerminal(session: StudioShellSession): void {
  const {
    adapterRef,
    editorDraftsRef,
    editorTabsRef,
    selectedPath,
    setEditorDiagnostics,
    setEditorDrafts,
    setEditorStatus,
    setEditorTabs,
    setError,
    setHasUnpublishedChanges,
    setIsEditorSplit,
    setSelectedPath,
    setSplitPath,
    setWorkspace,
    splitPathRef,
    terminal
  } = session;
  async function runCommand(command: string): Promise<void> {
    if (!command) return;
    if (command.length > MAX_TERMINAL_COMMAND_CHARS) {
      setError("터미널 명령어가 너무 깁니다.");
      return;
    }
    setError(undefined);
    const sessionId = terminal.activeSessionId;
    terminal.append(sessionId, `❯ ${command}\n`);
    try {
      const adapter = adapterRef.current;
      if (!adapter) throw new Error("runtime unavailable");
      session.persistSelectedEditorToDraft(adapter);
      const result = await adapter.terminal.run(command, `ide-terminal-${sessionId}`, (chunk) => terminal.append(sessionId, chunk.data));
      const changedFiles = result.changedFiles ?? [];
      for (const change of changedFiles) {
        session.hotUpdatePreviews(change.path, change.kind);
      }
      if (/^(?:npm|pnpm|yarn)\s+(?:install|i|add|update|up)(?:\s|$)/u.test(command.trim()) && result.exitCode === 0) {
        session.hotUpdatePreviews(previewModuleRefreshPath(adapter.workspace.getState().files.map((file) => file.path)));
      }
      if (changedFiles.length > 0) {
        const nextWorkspace = adapter.workspace.getState();
        setWorkspace(nextWorkspace);
        setHasUnpublishedChanges(true);
        let nextTabs = editorTabsRef.current;
        let nextDrafts = editorDraftsRef.current;
        let nextSplitPath = splitPathRef.current;
        for (const change of changedFiles) {
          if (change.kind === "rename" && change.previousPath) {
            nextTabs = renameEditorPath(nextTabs, change.previousPath, change.path);
            nextDrafts = renameEditorDraft(nextDrafts, change.previousPath, change.path);
            if (nextSplitPath === change.previousPath) nextSplitPath = change.path;
          } else if (change.kind === "delete") {
            nextTabs = closeEditorFile(nextTabs, change.path);
            nextDrafts = forgetEditorDraft(nextDrafts, change.path);
            if (nextSplitPath === change.path) nextSplitPath = undefined;
          } else if (change.kind === "content") {
            nextDrafts = forgetEditorDraft(nextDrafts, change.path);
          }
        }
        editorDraftsRef.current = nextDrafts;
        setEditorDrafts(nextDrafts);
        if (nextSplitPath !== splitPathRef.current) {
          setSplitPath(nextSplitPath);
          if (!nextSplitPath) {
            setIsEditorSplit(false);
            session.showSplitText("");
          }
        }
        const selectedRename = changedFiles.find((change) => change.kind === "rename" && change.previousPath === selectedPath);
        if (selectedRename) {
          setEditorTabs(nextTabs);
          setSelectedPath(selectedRename.path);
          session.showEditorText(adapter.workspace.readText(selectedRename.path));
          setEditorStatus("터미널에서 파일 이름 변경됨 · 로컬 초안");
        } else if (selectedPath && changedFiles.some((change) => change.path === selectedPath && change.kind === "content")) {
          setEditorTabs(nextTabs);
          session.showEditorText(adapter.workspace.readText(selectedPath));
          setEditorStatus("터미널 변경 반영됨 · 로컬 초안");
        } else if (selectedPath && changedFiles.some((change) => change.path === selectedPath && change.kind === "delete")) {
          const availablePaths = new Set(nextWorkspace.files.filter((file) => file.kind === "text").map((file) => file.path));
          const fallback = nextTabs.openPaths.at(-1) ?? nextWorkspace.files.find((file) => file.kind === "text")?.path;
          const nextPath = fallback && availablePaths.has(fallback) ? fallback : undefined;
          if (nextPath && !nextTabs.openPaths.includes(nextPath)) nextTabs = openEditorFile(nextTabs, nextPath, "preview");
          setEditorTabs(nextTabs);
          setSelectedPath(nextPath);
          session.showEditorText(nextPath ? adapter.workspace.readText(nextPath) : "");
          setEditorDiagnostics([]);
          setEditorStatus("터미널에서 파일 삭제됨 · 로컬 초안");
        } else {
          setEditorTabs(nextTabs);
        }
        const selectedAfter = selectedRename?.path ?? selectedPath;
        if (nextSplitPath && nextSplitPath !== selectedAfter && changedFiles.some((change) => change.path === nextSplitPath && (change.kind === "content" || change.kind === "rename"))) {
          session.showSplitText(adapter.workspace.readText(nextSplitPath));
        }
      }
    } catch {
      setError("터미널 명령을 완료하지 못했습니다.");
    }
  }

  function stopTerminalProcess(terminalId: string): void {
    const adapter = adapterRef.current;
    if (!adapter) return;
    setError(undefined);
    if (!adapter.terminal.signal("SIGTERM", terminalId)) {
      setError("이미 종료됐거나 찾을 수 없는 프로세스입니다.");
    }
  }
  session.runCommand = runCommand;
  session.stopTerminalProcess = stopTerminalProcess;
}

export function StudioTerminalDock({
  consoleActions,
  consolePanel,
  portList,
  session
}: {
  readonly consoleActions: ReactNode;
  readonly consolePanel: ReactNode;
  readonly portList: ReactNode;
  readonly session: StudioShellSession;
}) {
  const {
    adapterRef,
    beginBottomPanelResize,
    bottomPanel,
    bottomPanelHeight,
    css,
    editorDiagnostics,
    isTerminalOpen,
    previewConsole,
    runCommand,
    runtime,
    selectedFileName,
    setBottomPanel,
    setEditorPositionRequest,
    setIsTerminalOpen,
    stopTerminalProcess,
    terminal
  } = session;
  function terminalSessionView() {
    if (bottomPanel === "terminal") return (<ProjectTerminalView
                key={terminal.activeSession.id}
                output={terminal.activeSession.output}
                sessionName={terminal.activeSession.name}
                onClear={() => terminal.clear()}
                onInput={(data) => { adapterRef.current?.terminal.input(data, `ide-terminal-${terminal.activeSessionId}`); }}
                onInterrupt={() => { adapterRef.current?.terminal.signal("SIGINT", `ide-terminal-${terminal.activeSessionId}`); }}
                onResize={(cols, rows) => { adapterRef.current?.terminal.resize(cols, rows, `ide-terminal-${terminal.activeSessionId}`); }}
                onRun={runCommand}
              />);
    return (null);
  }
  function processList() {
    if (runtime.processes.length > 0) return (<ul className={css.runtimeList()} aria-label="실행 중 프로세스">{runtime.processes.map((process) => {
          const processSizeLabel = process.terminalSize ? (` · ${process.terminalSize.cols}×${process.terminalSize.rows}`) : ("");
          return (<li key={`${process.terminalId}:${process.pid}:${process.generation ?? 0}`}><div className="grid min-w-0 gap-0.5"><strong>{process.command}</strong><span>PID {process.pid} · {process.terminalId} · {process.cwd}{processSizeLabel}</span></div><Button type="button" size="sm" variant="ghost" aria-label={`${process.command} 프로세스 종료`} onClick={() => stopTerminalProcess(process.terminalId)}>종료</Button></li>);
        })}</ul>);
    return (<p className="m-0 p-3 text-xs text-white/55">실행 중인 터미널 프로세스가 없습니다.</p>);
  }
  const processPanel = bottomPanel === "processes" ? (processList()) : (null);

  function terminalOutput() {
    if (bottomPanel === "output") return (<pre className="m-0 min-h-0 overflow-auto whitespace-pre-wrap p-3 font-mono text-xs text-white/70" aria-live="polite">{terminal.activeSession.output || "실행 출력을 기다리고 있습니다."}</pre>);
    return (null);
  }

  function problemEntries() {
    if (editorDiagnostics.length > 0) return (<ul className="m-0 grid list-none gap-2 p-0">{editorDiagnostics.map((diagnostic, index) => {
          const diagnosticGlyph = diagnostic.severity >= 8 ? ("●") : ("▲");
          return (<li className="grid grid-cols-[auto_minmax(0,1fr)_auto] gap-2" key={`${diagnostic.line}:${diagnostic.column}:${index}`}><span aria-hidden="true">{diagnosticGlyph}</span><span>{diagnostic.message}</span><Button className="border-0 bg-transparent font-mono text-white/55 hover:text-white" type="button" size="sm" variant="ghost" onClick={() => setEditorPositionRequest({ column: diagnostic.column, line: diagnostic.line, requestId: Date.now() })}>{selectedFileName}:{diagnostic.line}:{diagnostic.column}</Button></li>);
        })}</ul>);
    return (<p className="m-0 text-white/55">현재 파일에서 발견된 문제가 없습니다.</p>);
  }
  function problemList() {
    if (bottomPanel === "problems") return (<div className="min-h-0 overflow-auto p-3 text-xs text-white/75">{problemEntries()}</div>);
    return (null);
  }

  function terminalPanelActions() {
    if (bottomPanel === "terminal") return (<>
                    <Button type="button" size="icon" variant="ghost" aria-label="새 터미널" title="새 터미널" onClick={() => { terminal.create(); setBottomPanel("terminal"); }}>＋</Button>
                    <Button type="button" size="icon" variant="ghost" aria-label="터미널 내용 지우기" title="터미널 내용 지우기 (Ctrl+L)" onClick={() => terminal.clear()}>⌫</Button>
                  </>);
    return (null);
  }
  const processCountLabel = runtime.processes.length > 0 ? (` ${runtime.processes.length}`) : ("");
  const portCountLabel = runtime.ports.length > 0 ? (` ${runtime.ports.length}`) : ("");
  const consoleCountLabel = previewConsole.length > 0 ? (` ${previewConsole.length}`) : ("");
  const problemCountLabel = editorDiagnostics.length > 0 ? (` ${editorDiagnostics.length}`) : ("");
  function bottomToolPanel() {
    if (isTerminalOpen) return (<section className={css.terminal()} aria-label="하단 도구 패널" style={{ height: bottomPanelHeight }}>
              <div className="absolute inset-x-0 top-[-0.25rem] z-20 h-2 cursor-row-resize touch-none" role="separator" aria-label="하단 패널 높이 조절" aria-orientation="horizontal" aria-valuemin={120} aria-valuemax={480} aria-valuenow={bottomPanelHeight} onPointerDown={beginBottomPanelResize} />
              <div className={css.terminalToolbar()}>
                <div role="toolbar" aria-label="하단 패널">
                  <Button type="button" size="sm" variant="ghost" aria-pressed={bottomPanel === "problems"} onClick={() => setBottomPanel("problems")}>문제{problemCountLabel}</Button>
                  <Button type="button" size="sm" variant="ghost" aria-pressed={bottomPanel === "console"} onClick={() => setBottomPanel("console")}>콘솔{consoleCountLabel}</Button>
                  <Button type="button" size="sm" variant="ghost" aria-pressed={bottomPanel === "output"} onClick={() => setBottomPanel("output")}>출력</Button>
                  <Button type="button" size="sm" variant="ghost" aria-pressed={bottomPanel === "ports"} onClick={() => setBottomPanel("ports")}>포트{portCountLabel}</Button>
                  <Button type="button" size="sm" variant="ghost" aria-pressed={bottomPanel === "processes"} onClick={() => setBottomPanel("processes")}>프로세스{processCountLabel}</Button>
                  {terminal.sessions.map((session) => <Button key={session.id} type="button" size="sm" variant="ghost" aria-pressed={bottomPanel === "terminal" && terminal.activeSessionId === session.id} title={session.name} onClick={() => { terminal.setActiveSessionId(session.id); setBottomPanel("terminal"); }}>{session.name}</Button>)}
                </div>
                <div className={css.terminalActions()}>
                  {terminalPanelActions()}
                  {consoleActions}
                  <Button type="button" size="icon" variant="ghost" aria-label="하단 패널 닫기" title="하단 패널 닫기" onClick={() => setIsTerminalOpen(false)}>×</Button>
                </div>
              </div>
              {problemList()}
              {consolePanel}
              {terminalOutput()}
              {portList}
              {processPanel}
              {terminalSessionView()}
            </section>);
    return (null);
  }
  return bottomToolPanel();
}

