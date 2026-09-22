import { DiffEditor, loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import type { PreviewControllerModel } from "../hooks/usePreviewController";

loader.config({ monaco });

export function DiffPane({ model }: { model: PreviewControllerModel }) {
  const diff = model.diffView;
  if (!diff) return null;

  return (
    <div className="flex h-full min-h-0 flex-col border-l border-cargo-line bg-cargo-bg" aria-label="Diff view">
      <div className="flex items-center justify-between gap-2 border-b border-cargo-line px-3 py-1.5 text-xs">
        <div className="min-w-0 truncate font-mono text-cargo-muted">
          Diff · {model.displayPath(diff.path)}
        </div>
        <button type="button" className="btn-small btn-ghost" onClick={() => model.closeDiffView()}>
          Close diff
        </button>
      </div>
      <div className="min-h-0 flex-1">
        <DiffEditor
          original={diff.original}
          modified={diff.modified}
          language={diff.language}
          theme={model.settings.theme === "light" ? "vs" : "vs-dark"}
          height="100%"
          options={{
            readOnly: true,
            renderSideBySide: true,
            automaticLayout: true,
            minimap: { enabled: false },
            fontFamily: "var(--mono)",
            fontSize: model.settings.fontSize
          }}
        />
      </div>
    </div>
  );
}
