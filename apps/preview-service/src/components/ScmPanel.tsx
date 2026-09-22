import type { PreviewControllerModel } from "../hooks/usePreviewController";

export function ScmPanel({ model }: { model: PreviewControllerModel }) {
  const { changeStatus, displayPath, openFile, openDiffView } = model;

  return (
    <aside className="flex h-full min-h-0 min-w-0 flex-col border-r border-cargo-line bg-cargo-elevated/60" aria-label="Source control">
      <div className="border-b border-cargo-line px-3 py-2">
        <h2 className="text-[11px] font-semibold tracking-[0.14em] text-cargo-muted uppercase">Source Control</h2>
      </div>
      <div className="space-y-3 overflow-auto p-3 text-xs">
        <div className="rounded-lg border border-cargo-line bg-cargo-panel p-3">
          <p className="font-semibold tracking-wide text-cargo-muted uppercase">Working tree</p>
          <p className="mt-1 text-cargo-ink">
            {changeStatus.hasGitMarker ? "Git marker present" : "Local dirty tracking (no git CLI yet)"}
          </p>
          <p className="mt-2 text-cargo-muted">{changeStatus.untrackedHint || "editor dirty set"}</p>
        </div>
        <div>
          <p className="mb-1 font-semibold text-cargo-muted uppercase">Changes ({changeStatus.dirty.length})</p>
          {changeStatus.dirty.length === 0 ? (
            <p className="text-cargo-muted">No dirty files.</p>
          ) : (
            <ul className="space-y-1">
              {changeStatus.dirty.map((path) => (
                <li key={path} className="rounded-md border border-cargo-line/70 bg-cargo-panel/60">
                  <button
                    type="button"
                    className="w-full px-2 py-1.5 text-left font-mono text-[11px] text-cargo-accent-strong hover:bg-cargo-panel-2"
                    onClick={() => openFile(path)}
                  >
                    M {displayPath(path)}
                  </button>
                  <div className="flex gap-1 border-t border-cargo-line/60 px-2 py-1">
                    <button type="button" className="btn-small" onClick={() => openDiffView(path)}>
                      Open diff
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </aside>
  );
}
