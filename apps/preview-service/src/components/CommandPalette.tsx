import { useEffect, useMemo, useState } from "react";
import { IDE_COMMANDS, type CommandId } from "../lib/commands";

export function CommandPalette({
  open,
  onClose,
  onRun,
  mode = "commands",
  filePaths = [],
  onOpenFile
}: {
  open: boolean;
  onClose: () => void;
  onRun: (id: CommandId) => void;
  mode?: "commands" | "files";
  filePaths?: string[];
  onOpenFile?: (path: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);

  const items = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (mode === "files") {
      return filePaths
        .filter((path) => !needle || path.toLowerCase().includes(needle))
        .slice(0, 50)
        .map((path) => ({ id: path, label: path.replace(/^\/workspace\/[^/]+\//, ""), shortcut: undefined as string | undefined }));
    }
    return IDE_COMMANDS.filter((command) => {
      if (!needle) return true;
      return command.label.toLowerCase().includes(needle) || command.id.includes(needle);
    }).map((command) => ({ id: command.id, label: command.label, shortcut: command.shortcut }));
  }, [filePaths, mode, query]);

  useEffect(() => {
    if (!open) {
      setQuery("");
      setIndex(0);
    }
  }, [open]);

  useEffect(() => {
    setIndex(0);
  }, [query, mode]);

  if (!open) return null;

  return (
    <div
      className="absolute inset-0 z-50 flex items-start justify-center bg-black/45 p-10"
      role="dialog"
      aria-modal="true"
      aria-label={mode === "files" ? "Go to file" : "Command palette"}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-xl overflow-hidden rounded-xl border border-cargo-line bg-cargo-panel shadow-[var(--shadow)]">
        <input
          autoFocus
          id="command-palette-input"
          value={query}
          placeholder={mode === "files" ? "Go to file…" : "Type a command…"}
          className="w-full border-b border-cargo-line bg-transparent px-4 py-3 text-sm text-cargo-ink outline-none"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              onClose();
              return;
            }
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setIndex((value) => Math.min(value + 1, Math.max(items.length - 1, 0)));
              return;
            }
            if (event.key === "ArrowUp") {
              event.preventDefault();
              setIndex((value) => Math.max(value - 1, 0));
              return;
            }
            if (event.key === "Enter") {
              event.preventDefault();
              const item = items[index];
              if (!item) return;
              if (mode === "files") onOpenFile?.(item.id);
              else onRun(item.id as CommandId);
              onClose();
            }
          }}
        />
        <ul className="max-h-80 overflow-auto py-1">
          {items.length === 0 ? (
            <li className="px-4 py-3 text-sm text-cargo-muted">No matches</li>
          ) : (
            items.map((item, itemIndex) => (
              <li key={item.id}>
                <button
                  type="button"
                  className={`flex w-full items-center justify-between px-4 py-2 text-left text-sm ${
                    itemIndex === index ? "bg-cargo-accent/15 text-cargo-accent-strong" : "text-cargo-ink hover:bg-cargo-panel-2"
                  }`}
                  onMouseEnter={() => setIndex(itemIndex)}
                  onClick={() => {
                    if (mode === "files") onOpenFile?.(item.id);
                    else onRun(item.id as CommandId);
                    onClose();
                  }}
                >
                  <span>{item.label}</span>
                  {item.shortcut ? <span className="font-mono text-[11px] text-cargo-muted">{item.shortcut}</span> : null}
                </button>
              </li>
            ))
          )}
        </ul>
      </div>
    </div>
  );
}
