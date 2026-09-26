import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type MouseEvent } from "react";
import Editor, { loader, type OnMount } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import { X } from "lucide-react";
import clsx from "clsx";
import type { PreviewControllerModel } from "../hooks/usePreviewController";
import { configureMonacoWorkers } from "../lib/monacoWorkers";
import { monacoModelPath, syncMonacoProjectFiles } from "../lib/monacoProjectSync";
import { subscribeToLanguageProblems, workspacePathForModel } from "../lib/monacoLanguageService";
import { ContextMenu } from "./ContextMenu";
import { EditorBreadcrumbs } from "./EditorBreadcrumbs";
import { monacoTheme } from "../lib/settings";
import { MonacoLspBridge } from "../lib/monacoLspBridge";
import type { LanguageServerState } from "../lib/browserLanguageServer";

loader.config({ monaco });

const TAB_MIME = "application/x-cargo-tab";

function languageForPath(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith(".tsx") || lower.endsWith(".ts")) return "typescript";
  if (lower.endsWith(".jsx") || lower.endsWith(".js") || lower.endsWith(".mjs") || lower.endsWith(".cjs"))
    return "javascript";
  if (lower.endsWith(".json")) return "json";
  if (lower.endsWith(".css")) return "css";
  if (lower.endsWith(".html") || lower.endsWith(".htm")) return "html";
  if (lower.endsWith(".md") || lower.endsWith(".markdown")) return "markdown";
  if (lower.endsWith(".svg")) return "xml";
  if (lower.endsWith(".yml") || lower.endsWith(".yaml")) return "yaml";
  return "plaintext";
}

export function CodeEditor({ model }: { model: PreviewControllerModel }) {
  const {
    selectedPath,
    openPaths,
    editorFile,
    splitPath,
    splitFile,
    displayPath,
    openFile,
    closeTab,
    editSelected,
    editFile,
    saveFile,
    saveCurrentFile,
    formatCurrentFile,
    reconnectHmr,
    previewLive,
    settings,
    setSplitPath,
    reorderOpenPaths,
    goToDefinition,
    languageProblems,
    setLanguageProblems,
    editorLocation
  } = model;

  const [workerState, setWorkerState] = useState<"starting" | "ready" | "failed">("starting");
  const [lspState, setLspState] = useState<LanguageServerState>("stopped");
  const [cursor, setCursor] = useState({ line: 1, column: 1 });
  const [tabMenu, setTabMenu] = useState<{
    x: number;
    y: number;
    path: string;
  } | null>(null);
  const [dragOverTab, setDragOverTab] = useState<string | null>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const editorSubscriptionsRef = useRef<monaco.IDisposable[]>([]);
  const lspBridgeRef = useRef<MonacoLspBridge | null>(null);
  const language = useMemo(() => (selectedPath ? languageForPath(selectedPath) : "plaintext"), [selectedPath]);

  useEffect(() => {
    let cancelled = false;
    void configureMonacoWorkers()
      .then(() => {
        if (!cancelled) setWorkerState("ready");
      })
      .catch((error: unknown) => {
        console.error(error);
        if (!cancelled) setWorkerState("failed");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const bridge = new MonacoLspBridge();
    lspBridgeRef.current = bridge;
    bridge.onStatus(setLspState);
    void bridge.start("file:///workspace").catch((error: unknown) => console.error(error));
    return () => {
      lspBridgeRef.current = null;
      void bridge.dispose();
    };
  }, []);

  useEffect(() => {
    if (workerState !== "ready") return;
    const files = model.snapshot.project?.listFiles() || [];
    const syncedFiles = files.map((file) => {
      const open = model.snapshot.editor?.openFile(file.path);
      return { path: file.path, data: open?.data ?? file.data };
    });
    syncMonacoProjectFiles(syncedFiles);
    lspBridgeRef.current?.sync(syncedFiles);
  }, [lspState, model.snapshot, workerState]);

  useEffect(() => {
    if (workerState !== "ready") return;
    const subscription = subscribeToLanguageProblems(setLanguageProblems);
    return () => subscription.dispose();
  }, [setLanguageProblems, workerState]);

  useEffect(() => {
    if (!editorLocation || editorLocation.path !== selectedPath) return;
    const editor = editorRef.current;
    if (!editor) return;
    const position = {
      lineNumber: editorLocation.line,
      column: editorLocation.column
    };
    editor.setPosition(position);
    editor.revealPositionInCenter(position);
    editor.focus();
  }, [editorLocation, selectedPath]);

  useEffect(
    () => () => {
      for (const subscription of editorSubscriptionsRef.current) subscription.dispose();
      editorSubscriptionsRef.current = [];
      editorRef.current = null;
    },
    []
  );

  const onEditorMount = useCallback<OnMount>(
    (editor) => {
      for (const subscription of editorSubscriptionsRef.current) subscription.dispose();
      editorSubscriptionsRef.current = [];
      editorRef.current = editor;

      const updateCursor = () => {
        const position = editor.getPosition();
        if (position) setCursor({ line: position.lineNumber, column: position.column });
      };

      editorSubscriptionsRef.current.push(
        editor.onDidChangeCursorPosition(updateCursor),
        editor.onDidChangeModel(() => {
          const path = workspacePathForModel(editor.getModel());
          if (path && path !== selectedPath) openFile(path);
        })
      );
      updateCursor();
    },
    [openFile, selectedPath]
  );

  const revealDefinition = useCallback(() => {
    const editor = editorRef.current;
    if (!editor) {
      goToDefinition();
      return;
    }
    editor.focus();
    editor.trigger("editor-toolbar", "editor.action.revealDefinition", null);
  }, [goToDefinition]);

  const errorCount = languageProblems.filter((problem) => problem.severity === "error").length;
  const warningCount = languageProblems.filter((problem) => problem.severity === "warning").length;

  const onTabDragStart = (event: DragEvent, path: string) => {
    event.dataTransfer.setData(TAB_MIME, path);
    event.dataTransfer.effectAllowed = "move";
  };

  const onTabDrop = (event: DragEvent, targetPath: string) => {
    event.preventDefault();
    setDragOverTab(null);
    const from = event.dataTransfer.getData(TAB_MIME);
    if (!from || from === targetPath) return;
    reorderOpenPaths(from, targetPath);
  };

  return (
    <section
      className="flex h-full min-h-0 min-w-0 flex-col border-r border-cargo-line bg-cargo-bg"
      aria-label="Editor"
    >
      <div className="flex items-center gap-2 border-b border-cargo-line bg-cargo-elevated/80 px-2">
        <div
          id="editor-tabs"
          className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto py-1.5"
          aria-label="Open files"
        >
          {openPaths.length === 0 ? (
            <span className="px-2 text-xs text-cargo-muted">No open files</span>
          ) : (
            openPaths.map((path) => {
              const active = path === selectedPath;
              const dirty = model.snapshot.editor?.dirtyFiles().some((file) => file.path === path) === true;
              return (
                <div
                  key={path}
                  draggable
                  onDragStart={(event) => onTabDragStart(event, path)}
                  onDragOver={(event) => {
                    event.preventDefault();
                    setDragOverTab(path);
                  }}
                  onDrop={(event) => onTabDrop(event, path)}
                  className={clsx(
                    "group flex max-w-[180px] items-center gap-1 rounded-md border px-2 py-1 text-xs",
                    active
                      ? "border-cargo-accent/50 bg-cargo-accent/10 text-cargo-accent-strong"
                      : "border-transparent text-cargo-muted hover:bg-cargo-panel-2 hover:text-cargo-ink",
                    dragOverTab === path && "ring-1 ring-cargo-accent/60"
                  )}
                  onContextMenu={(event: MouseEvent) => {
                    event.preventDefault();
                    setTabMenu({ x: event.clientX, y: event.clientY, path });
                  }}
                >
                  <button type="button" className="truncate" onClick={() => openFile(path)}>
                    {displayPath(path).split("/").pop()}
                    {dirty ? " •" : ""}
                  </button>
                  <button
                    type="button"
                    className="rounded p-0.5 opacity-60 hover:bg-cargo-line/60 hover:opacity-100"
                    aria-label={`Close ${displayPath(path)}`}
                    onClick={() => closeTab(path)}
                  >
                    <X className="size-3" />
                  </button>
                </div>
              );
            })
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1.5 py-1.5">
          <button
            id="editor-goto-def"
            type="button"
            className="btn-small btn-ghost"
            disabled={!selectedPath}
            title="Go to Definition (F12)"
            onClick={revealDefinition}
          >
            Definition
          </button>
          <button
            id="editor-format"
            type="button"
            className="btn-small"
            disabled={!selectedPath}
            onClick={() => void formatCurrentFile()}
          >
            Format
          </button>
          <button
            id="editor-split"
            type="button"
            className="btn-small btn-ghost"
            disabled={!selectedPath}
            onClick={() => setSplitPath(selectedPath || null)}
          >
            Split
          </button>
          <button
            id="editor-save"
            type="button"
            className="btn-small"
            disabled={!selectedPath}
            onClick={() => saveCurrentFile()}
          >
            Save
          </button>
          <button
            id="reconnect-hmr"
            type="button"
            className="btn-small btn-ghost"
            disabled={!previewLive}
            onClick={() => void reconnectHmr().catch(() => undefined)}
          >
            Reconnect HMR
          </button>
        </div>
      </div>

      <div className="flex items-center justify-between gap-3 border-b border-cargo-line px-3 py-1.5 text-xs">
        <EditorBreadcrumbs path={selectedPath || null} displayPath={displayPath} />
        <span
          id="editor-status"
          className={clsx(
            "rounded-full border px-2 py-0.5 font-medium",
            editorFile?.dirty ? "border-amber-700/40 text-cargo-warn" : "border-cargo-line text-cargo-muted"
          )}
        >
          {!selectedPath
            ? "empty"
            : editorFile?.dirty
              ? settings.saveTrigger === "autosave"
                ? "unsaved · autosave"
                : "unsaved"
              : "saved"}
        </span>
      </div>

      <div className={clsx("min-h-0 flex-1", splitPath ? "grid grid-cols-2" : "flex flex-col")}>
        <div className="relative min-h-0 min-w-0 flex-1">
          {selectedPath && editorFile && workerState === "ready" ? (
            <Editor
              key={selectedPath}
              path={monacoModelPath(selectedPath)}
              language={language}
              value={editorFile.data}
              height="100%"
              theme={monacoTheme(settings.theme)}
              onChange={(value) => editSelected(value ?? "")}
              onMount={onEditorMount}
              options={{
                fontFamily: "var(--mono)",
                fontSize: settings.fontSize,
                minimap: { enabled: settings.editorMinimap },
                wordWrap: settings.wordWrap ? "on" : "off",
                scrollBeyondLastLine: false,
                automaticLayout: true,
                tabSize: 2,
                padding: { top: 12 },
                quickSuggestions: true,
                suggestOnTriggerCharacters: true,
                parameterHints: { enabled: true },
                inlayHints: { enabled: "on" },
                definitionLinkOpensInPeek: false
              }}
            />
          ) : (
            <div className="flex h-full items-center justify-center px-6 text-sm text-cargo-muted">
              {selectedPath && workerState === "failed"
                ? "Editor language workers failed to start. Check the built Monaco worker assets."
                : selectedPath && workerState === "starting"
                  ? "Starting editor…"
                  : "Select a file from the sidebar to edit."}
            </div>
          )}
        </div>
        {splitPath && splitFile ? (
          <div className="flex min-h-0 min-w-0 flex-col border-l border-cargo-line">
            <div className="flex shrink-0 items-center justify-between border-b border-cargo-line px-2 py-1 text-[11px] text-cargo-muted">
              <span className="truncate font-mono">{displayPath(splitPath)}{splitFile.dirty ? " •" : ""}</span>
              <div className="flex items-center gap-1">
                <button type="button" className="btn-small" disabled={!splitFile.dirty} onClick={() => saveFile(splitPath)}>
                  Save
                </button>
                <button type="button" className="btn-small btn-ghost" onClick={() => setSplitPath(null)}>
                  Close split
                </button>
              </div>
            </div>
            <div className="relative min-h-0 flex-1">
              <Editor
                key={`split-${splitPath}`}
                path={monacoModelPath(splitPath)}
                language={languageForPath(splitPath)}
                value={splitFile.data}
                onChange={(value) => editFile(splitPath, value ?? "")}
                height="100%"
                theme={monacoTheme(settings.theme)}
                options={{
                  fontFamily: "var(--mono)",
                  fontSize: settings.fontSize,
                  minimap: { enabled: settings.editorMinimap },
                  wordWrap: settings.wordWrap ? "on" : "off",
                  automaticLayout: true,
                  scrollBeyondLastLine: false
                }}
              />
            </div>
          </div>
        ) : null}
      </div>

      <div
        id="editor-statusbar"
        className="flex items-center justify-between gap-3 border-t border-cargo-line px-3 py-1 font-mono text-[11px] text-cargo-muted"
      >
        <span>
          {selectedPath
            ? `${language} · ${displayPath(selectedPath)} · ${settings.saveTrigger} · F1 commands`
            : "No file open · F1 command palette · ⌘P go to file"}
        </span>
        {selectedPath ? (
          <span className="shrink-0" aria-label={`${errorCount} errors and ${warningCount} warnings`}>
            Ln {cursor.line}, Col {cursor.column} · × {errorCount} · △ {warningCount} · Language Service {workerState} · LSP {lspState}
          </span>
        ) : null}
      </div>

      <ContextMenu
        open={Boolean(tabMenu)}
        x={tabMenu?.x || 0}
        y={tabMenu?.y || 0}
        items={[
          { id: "close", label: "Close" },
          { id: "close-others", label: "Close Others" },
          { id: "close-all", label: "Close All" },
          { id: "sep", label: "", separator: true },
          { id: "split", label: "Split Right" }
        ]}
        onClose={() => setTabMenu(null)}
        onSelect={(id) => {
          if (!tabMenu) return;
          if (id === "close") closeTab(tabMenu.path);
          if (id === "close-others") {
            for (const path of openPaths) {
              if (path !== tabMenu.path) closeTab(path);
            }
            openFile(tabMenu.path);
          }
          if (id === "close-all") {
            for (const path of [...openPaths]) closeTab(path);
          }
          if (id === "split") setSplitPath(tabMenu.path);
        }}
      />
    </section>
  );
}
