import { useEffect, useMemo, useState, type DragEvent, type MouseEvent } from "react";
import Editor, { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import { X } from "lucide-react";
import clsx from "clsx";
import type { PreviewControllerModel } from "../hooks/usePreviewController";
import { configureMonacoWorkers } from "../lib/monacoWorkers";
import { syncMonacoProjectFiles } from "../lib/monacoProjectSync";
import { ContextMenu } from "./ContextMenu";

loader.config({ monaco });

const TAB_MIME = "application/x-cargo-tab";

function languageForPath(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith(".tsx") || lower.endsWith(".ts")) return "typescript";
  if (lower.endsWith(".jsx") || lower.endsWith(".js") || lower.endsWith(".mjs") || lower.endsWith(".cjs")) return "javascript";
  if (lower.endsWith(".json")) return "json";
  if (lower.endsWith(".css")) return "css";
  if (lower.endsWith(".html") || lower.endsWith(".htm")) return "html";
  if (lower.endsWith(".md") || lower.endsWith(".markdown")) return "markdown";
  if (lower.endsWith(".svg")) return "xml";
  if (lower.endsWith(".yml") || lower.endsWith(".yaml")) return "yaml";
  return "plaintext";
}

function breadcrumbParts(path: string, displayPath: (path: string) => string): string[] {
  return displayPath(path).split("/").filter(Boolean);
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
    saveCurrentFile,
    formatCurrentFile,
    reconnectHmr,
    previewLive,
    settings,
    setSplitPath,
    reorderOpenPaths,
    goToDefinition
  } = model;

  const [workersReady, setWorkersReady] = useState(false);
  const [tabMenu, setTabMenu] = useState<{ x: number; y: number; path: string } | null>(null);
  const [dragOverTab, setDragOverTab] = useState<string | null>(null);
  const language = useMemo(
    () => (selectedPath ? languageForPath(selectedPath) : "plaintext"),
    [selectedPath]
  );
  const crumbs = useMemo(
    () => (selectedPath ? breadcrumbParts(selectedPath, displayPath) : []),
    [displayPath, selectedPath]
  );

  useEffect(() => {
    let cancelled = false;
    void configureMonacoWorkers().then(() => {
      if (!cancelled) setWorkersReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!workersReady) return;
    const files = model.snapshot.project?.listFiles() || [];
    syncMonacoProjectFiles(
      files.map((file) => {
        const open = model.snapshot.editor?.openFile(file.path);
        return { path: file.path, data: open?.data ?? file.data };
      })
    );
  }, [model.snapshot, workersReady]);

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
    <section className="flex h-full min-h-0 min-w-0 flex-col border-r border-cargo-line bg-cargo-bg" aria-label="Editor">
      <div className="flex items-center gap-2 border-b border-cargo-line bg-cargo-elevated/80 px-2">
        <div id="editor-tabs" className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto py-1.5" aria-label="Open files">
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
            onClick={() => goToDefinition()}
          >
            Definition
          </button>
          <button id="editor-format" type="button" className="btn-small" disabled={!selectedPath} onClick={() => void formatCurrentFile()}>
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
          <button id="editor-save" type="button" className="btn-small" disabled={!selectedPath} onClick={() => saveCurrentFile()}>
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
        <nav id="editor-breadcrumbs" className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden font-mono text-cargo-muted" aria-label="Breadcrumbs">
          {crumbs.length === 0 ? (
            <span id="editor-path">Open a file</span>
          ) : (
            crumbs.map((part, index) => (
              <span key={`${part}-${index}`} className="flex items-center gap-1">
                {index > 0 ? <span className="opacity-50">/</span> : null}
                <span className={index === crumbs.length - 1 ? "text-cargo-ink" : ""}>{part}</span>
              </span>
            ))
          )}
          <span id="editor-path" className="sr-only">{selectedPath ? displayPath(selectedPath) : "Open a file"}</span>
        </nav>
        <span
          id="editor-status"
          className={clsx(
            "rounded-full border px-2 py-0.5 font-medium",
            editorFile?.dirty ? "border-amber-700/40 text-cargo-warn" : "border-cargo-line text-cargo-muted"
          )}
        >
          {!selectedPath ? "empty" : editorFile?.dirty ? (settings.saveTrigger === "autosave" ? "unsaved · autosave" : "unsaved") : "saved"}
        </span>
      </div>

      <div className={clsx("min-h-0 flex-1", splitPath ? "grid grid-cols-2" : "flex flex-col")}>
        <div className="relative min-h-0 min-w-0 flex-1">
          {selectedPath && editorFile && workersReady ? (
            <Editor
              key={selectedPath}
              path={selectedPath}
              language={language}
              value={editorFile.data}
              height="100%"
              theme={settings.theme === "light" ? "vs" : "vs-dark"}
              onChange={(value) => editSelected(value ?? "")}
              options={{
                fontFamily: "var(--mono)",
                fontSize: settings.fontSize,
                minimap: { enabled: false },
                scrollBeyondLastLine: false,
                automaticLayout: true,
                tabSize: 2,
                padding: { top: 12 },
                quickSuggestions: true
              }}
            />
          ) : (
            <div className="flex h-full items-center justify-center px-6 text-sm text-cargo-muted">
              {selectedPath && !workersReady ? "Starting editor…" : "Select a file from the sidebar to edit."}
            </div>
          )}
        </div>
        {splitPath && splitFile ? (
          <div className="flex min-h-0 min-w-0 flex-col border-l border-cargo-line">
            <div className="flex shrink-0 items-center justify-between border-b border-cargo-line px-2 py-1 text-[11px] text-cargo-muted">
              <span className="truncate font-mono">{displayPath(splitPath)}</span>
              <button type="button" className="btn-small btn-ghost" onClick={() => setSplitPath(null)}>Close split</button>
            </div>
            <div className="relative min-h-0 flex-1">
              <Editor
                key={`split-${splitPath}`}
                path={`split:${splitPath}`}
                language={languageForPath(splitPath)}
                value={splitFile.data}
                height="100%"
                theme={settings.theme === "light" ? "vs" : "vs-dark"}
                options={{
                  fontFamily: "var(--mono)",
                  fontSize: settings.fontSize,
                  readOnly: true,
                  minimap: { enabled: false },
                  automaticLayout: true,
                  scrollBeyondLastLine: false
                }}
              />
            </div>
          </div>
        ) : null}
      </div>

      <div id="editor-statusbar" className="border-t border-cargo-line px-3 py-1 font-mono text-[11px] text-cargo-muted">
        {selectedPath
          ? `${language} · ${displayPath(selectedPath)} · ${settings.saveTrigger} · F1 commands`
          : "No file open · F1 command palette · ⌘P go to file"}
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
