import { useMemo, useState } from "react";
import type { PreviewControllerModel } from "../hooks/usePreviewController";

type SearchHit = { path: string; line: number; column: number; snippet: string };

export function SearchPanel({ model }: { model: PreviewControllerModel }) {
  const [query, setQuery] = useState("");
  const [replace, setReplace] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [useRegex, setUseRegex] = useState(false);
  const [includeGlob, setIncludeGlob] = useState("**/*.{ts,tsx,js,jsx,css,html,md,json}");
  const [excludeGlob, setExcludeGlob] = useState("**/node_modules/**");
  const [status, setStatus] = useState("");

  const matches = useMemo(() => {
    const editor = model.snapshot.editor;
    if (!editor || !query) return [] as SearchHit[];

    let pattern: RegExp | null = null;
    try {
      pattern = new RegExp(useRegex ? query : escapeRegExp(query), caseSensitive ? "g" : "gi");
    } catch {
      return [];
    }

    const out: SearchHit[] = [];
    for (const file of editor.store.listFiles()) {
      const relative = model.displayPath(file.path);
      if (!matchGlob(relative, includeGlob) || matchGlob(relative, excludeGlob)) continue;
      const lines = file.data.split("\n");
      for (let index = 0; index < lines.length; index += 1) {
        const lineText = lines[index] ?? "";
        pattern.lastIndex = 0;
        let match = pattern.exec(lineText);
        while (match) {
          out.push({
            path: file.path,
            line: index + 1,
            column: (match.index || 0) + 1,
            snippet: lineText.trim()
          });
          if (out.length >= 200) return out;
          if (!pattern.global) break;
          match = pattern.exec(lineText);
        }
      }
    }
    return out;
  }, [caseSensitive, excludeGlob, includeGlob, model, query, useRegex]);

  const runReplaceAll = () => {
    if (!query) return;
    const count = model.replaceInFiles({
      query,
      replace,
      caseSensitive,
      useRegex,
      includeGlob,
      excludeGlob
    });
    setStatus(count === 0 ? "No replacements" : `Replaced ${count} occurrence(s)`);
  };

  return (
    <aside className="flex h-full min-h-0 min-w-0 flex-col border-r border-cargo-line bg-cargo-elevated/60" aria-label="Search">
      <div className="border-b border-cargo-line px-3 py-2">
        <h2 className="text-[11px] font-semibold tracking-[0.14em] text-cargo-muted uppercase">Search</h2>
      </div>
      <div className="space-y-2 border-b border-cargo-line px-2 py-2">
        <input
          id="search-query"
          type="search"
          value={query}
          placeholder="Search in files"
          aria-label="Search in files"
          onChange={(event) => setQuery(event.target.value)}
          className="w-full rounded-md border border-cargo-line bg-cargo-panel px-2.5 py-1.5 text-xs text-cargo-ink outline-none focus:border-cargo-accent"
        />
        <input
          id="search-replace"
          type="text"
          value={replace}
          placeholder="Replace"
          aria-label="Replace"
          onChange={(event) => setReplace(event.target.value)}
          className="w-full rounded-md border border-cargo-line bg-cargo-panel px-2.5 py-1.5 text-xs text-cargo-ink outline-none focus:border-cargo-accent"
        />
        <div className="grid grid-cols-2 gap-2">
          <input
            type="text"
            value={includeGlob}
            aria-label="Include glob"
            title="Include"
            onChange={(event) => setIncludeGlob(event.target.value)}
            className="w-full rounded-md border border-cargo-line bg-cargo-panel px-2 py-1 text-[11px] text-cargo-ink outline-none"
          />
          <input
            type="text"
            value={excludeGlob}
            aria-label="Exclude glob"
            title="Exclude"
            onChange={(event) => setExcludeGlob(event.target.value)}
            className="w-full rounded-md border border-cargo-line bg-cargo-panel px-2 py-1 text-[11px] text-cargo-ink outline-none"
          />
        </div>
        <div className="flex flex-wrap items-center gap-3 text-[11px] text-cargo-muted">
          <label className="inline-flex items-center gap-1.5">
            <input type="checkbox" checked={caseSensitive} onChange={(e) => setCaseSensitive(e.target.checked)} />
            Case
          </label>
          <label className="inline-flex items-center gap-1.5">
            <input type="checkbox" checked={useRegex} onChange={(e) => setUseRegex(e.target.checked)} />
            Regex
          </label>
          <button type="button" className="btn-small" disabled={!query} onClick={runReplaceAll}>
            Replace all
          </button>
        </div>
        {status ? <p className="text-[11px] text-cargo-accent-strong">{status}</p> : null}
      </div>
      <ol className="min-h-0 flex-1 space-y-1 overflow-auto p-2" aria-label="Search results">
        {matches.length === 0 ? (
          <li className="px-2 py-3 text-xs text-cargo-muted">{query ? "No matches" : "Type to search"}</li>
        ) : (
          matches.map((match) => (
            <li key={`${match.path}:${match.line}:${match.column}`}>
              <button
                type="button"
                className="w-full rounded-md px-2 py-1.5 text-left hover:bg-cargo-panel-2"
                onClick={() => model.openFile(match.path)}
              >
                <div className="truncate font-mono text-[11px] text-cargo-accent-strong">
                  {model.displayPath(match.path)}:{match.line}
                </div>
                <div className="truncate text-xs text-cargo-muted">{match.snippet}</div>
              </button>
            </li>
          ))
        )}
      </ol>
    </aside>
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function matchGlob(path: string, glob: string): boolean {
  if (!glob.trim()) return true;
  const patterns = glob.split(",").map((part) => part.trim()).filter(Boolean);
  return patterns.some((pattern) => globToRegExp(pattern).test(path));
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, ":::DOUBLE_STAR:::")
    .replace(/\*/g, "[^/]*")
    .replace(/:::DOUBLE_STAR:::/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`);
}
