import { DiffEditor, loader, type DiffOnMount } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PreviewControllerModel } from "../hooks/usePreviewController";
import { createFallbackLineChanges, summarizeDiffChanges } from "../lib/diffSummary";
import { monacoTheme } from "../lib/settings";

loader.config({ monaco });

export function DiffPane({ model }: { model: PreviewControllerModel }) {
  const diff = model.diffView;
  const editorRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null);
  const diffListenerRef = useRef<monaco.IDisposable | null>(null);
  const [viewMode, setViewMode] = useState<"split" | "unified">("split");
  const [lineChanges, setLineChanges] = useState<monaco.editor.ILineChange[]>([]);
  const [activeChange, setActiveChange] = useState(0);
  const fallbackChanges = useMemo<monaco.editor.ILineChange[]>(() => {
    if (!diff) return [];
    return createFallbackLineChanges(diff.original, diff.modified).map((change) => ({
      ...change,
      charChanges: undefined
    }));
  }, [diff]);

  useEffect(() => () => diffListenerRef.current?.dispose(), []);
  useEffect(() => {
    setLineChanges(fallbackChanges);
    setActiveChange(0);
  }, [fallbackChanges]);

  const handleMount = useCallback<DiffOnMount>((editor) => {
    diffListenerRef.current?.dispose();
    editorRef.current = editor;
    const updateChanges = () => {
      const computed = editor.getLineChanges();
      setLineChanges(computed && computed.length > 0 ? computed : fallbackChanges);
      setActiveChange(0);
    };
    diffListenerRef.current = editor.onDidUpdateDiff(updateChanges);
    updateChanges();
  }, [fallbackChanges]);

  const summary = useMemo(() => summarizeDiffChanges(lineChanges), [lineChanges]);

  const navigateChange = useCallback((direction: -1 | 1) => {
    if (lineChanges.length === 0) return;
    const nextIndex = (activeChange + direction + lineChanges.length) % lineChanges.length;
    const change = lineChanges[nextIndex];
    if (!change) return;
    setActiveChange(nextIndex);
    const line = Math.max(1, change.modifiedStartLineNumber || change.originalStartLineNumber);
    const editor = editorRef.current?.getModifiedEditor();
    editor?.revealLineInCenter(line);
    editor?.setPosition({ lineNumber: line, column: 1 });
    editor?.focus();
  }, [activeChange, lineChanges]);

  if (!diff) return null;

  return (
    <section className="flex h-full min-h-0 flex-col border-l border-cargo-line bg-cargo-bg" aria-label="Diff editor">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-cargo-line px-3 py-1.5 text-xs">
        <div className="min-w-0 truncate font-mono text-cargo-muted">
          Diff · {model.displayPath(diff.path)}
        </div>
        <div className="flex flex-wrap items-center justify-end gap-1">
          <div className="flex" role="group" aria-label="Diff layout">
            <button
              type="button"
              className="btn-small rounded-r-none"
              aria-pressed={viewMode === "unified"}
              onClick={() => setViewMode("unified")}
            >
              Unified
            </button>
            <button
              type="button"
              className="btn-small rounded-l-none"
              aria-pressed={viewMode === "split"}
              onClick={() => setViewMode("split")}
            >
              Split
            </button>
          </div>
          <button
            type="button"
            className="btn-small btn-ghost"
            disabled={lineChanges.length === 0}
            aria-label="Previous change"
            onClick={() => navigateChange(-1)}
          >
            ↑
          </button>
          <button
            type="button"
            className="btn-small btn-ghost"
            disabled={lineChanges.length === 0}
            aria-label="Next change"
            onClick={() => navigateChange(1)}
          >
            ↓
          </button>
          <button type="button" className="btn-small btn-ghost" onClick={() => model.closeDiffView()}>
            Close diff
          </button>
        </div>
      </div>
      <div className="flex items-center gap-3 border-b border-cargo-line px-3 py-1 font-mono text-[11px] text-cargo-muted" aria-live="polite">
        <span className="text-cargo-ok">+{summary.added}</span>
        <span className="text-cargo-bad">−{summary.removed}</span>
        <span className="text-cargo-warn">~{summary.changed}</span>
        <span>{summary.hunks} {summary.hunks === 1 ? "change" : "changes"}</span>
        {summary.hunks > 0 ? <span>Viewing {activeChange + 1} of {summary.hunks}</span> : null}
      </div>
      <div className="min-h-0 flex-1">
        <DiffEditor
          original={diff.original}
          modified={diff.modified}
          language={diff.language}
          theme={monacoTheme(model.settings.theme)}
          height="100%"
          onMount={handleMount}
          options={{
            readOnly: true,
            originalEditable: false,
            renderSideBySide: viewMode === "split",
            renderIndicators: true,
            renderMarginRevertIcon: false,
            automaticLayout: true,
            minimap: { enabled: false },
            fontFamily: "var(--mono)",
            fontSize: model.settings.fontSize,
            accessibilitySupport: "auto"
          }}
        />
      </div>
    </section>
  );
}
