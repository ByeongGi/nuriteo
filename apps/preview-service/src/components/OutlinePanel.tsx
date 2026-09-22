import { useMemo } from "react";
import type { PreviewControllerModel } from "../hooks/usePreviewController";

type OutlineSymbol = { name: string; kind: string; line: number };

export function OutlinePanel({ model }: { model: PreviewControllerModel }) {
  const symbols = useMemo(() => {
    const data = model.editorFile?.data || "";
    if (!data) return [] as OutlineSymbol[];
    const lines = data.split("\n");
    const out: OutlineSymbol[] = [];
    const patterns: Array<{ kind: string; re: RegExp }> = [
      { kind: "function", re: /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_]+)/ },
      { kind: "class", re: /^\s*(?:export\s+)?class\s+([A-Za-z0-9_]+)/ },
      { kind: "const", re: /^\s*(?:export\s+)?const\s+([A-Za-z0-9_]+)\s*=/ },
      { kind: "type", re: /^\s*(?:export\s+)?(?:type|interface)\s+([A-Za-z0-9_]+)/ }
    ];
    lines.forEach((line, index) => {
      for (const pattern of patterns) {
        const match = line.match(pattern.re);
        if (!match?.[1]) continue;
        out.push({ name: match[1], kind: pattern.kind, line: index + 1 });
        break;
      }
    });
    return out;
  }, [model.editorFile?.data]);

  return (
    <aside className="flex h-full min-h-0 min-w-0 flex-col border-r border-cargo-line bg-cargo-elevated/60" aria-label="Outline">
      <div className="border-b border-cargo-line px-3 py-2">
        <h2 className="text-[11px] font-semibold tracking-[0.14em] text-cargo-muted uppercase">Outline</h2>
      </div>
      <div className="border-b border-cargo-line px-3 py-2 font-mono text-[11px] text-cargo-muted">
        {model.selectedPath ? model.displayPath(model.selectedPath) : "No file open"}
      </div>
      <ol className="min-h-0 flex-1 space-y-1 overflow-auto p-2">
        {symbols.length === 0 ? (
          <li className="px-2 py-3 text-xs text-cargo-muted">No symbols detected.</li>
        ) : (
          symbols.map((symbol) => (
            <li key={`${symbol.kind}-${symbol.name}-${symbol.line}`}>
              <button
                type="button"
                className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-xs hover:bg-cargo-panel-2"
                onClick={() => {
                  if (model.selectedPath) model.openFile(model.selectedPath);
                }}
              >
                <span className="text-cargo-ink">{symbol.name}</span>
                <span className="font-mono text-[10px] text-cargo-muted">{symbol.kind}:{symbol.line}</span>
              </button>
            </li>
          ))
        )}
      </ol>
    </aside>
  );
}
