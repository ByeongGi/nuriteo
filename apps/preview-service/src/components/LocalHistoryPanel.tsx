import type { PreviewControllerModel } from "../hooks/usePreviewController";

const REVISION_TIME_FORMATTER = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit"
});

export function LocalHistoryPanel({ model }: { model: PreviewControllerModel }) {
  const revisions = model.localHistoryRevisions;

  return (
    <aside
      className="flex h-full min-h-0 min-w-0 flex-col border-r border-nuriteo-line bg-nuriteo-elevated/60"
      aria-label="Timeline"
    >
      <div className="border-b border-nuriteo-line px-3 py-2">
        <h2 className="text-[11px] font-semibold tracking-[0.14em] text-nuriteo-muted uppercase">Timeline</h2>
        <p className="mt-1 text-[11px] text-nuriteo-muted">Local edit and save checkpoints</p>
      </div>

      {!model.localHistoryPersistent ? (
        <p className="border-b border-nuriteo-line px-3 py-2 text-xs text-nuriteo-warn" role="status">
          Storage quota is unavailable. History remains available for this session.
        </p>
      ) : null}

      <ol className="min-h-0 flex-1 space-y-1 overflow-auto p-2" aria-label="Local history revisions">
        {revisions.length === 0 ? (
          <li className="px-2 py-3 text-xs text-nuriteo-muted">
            Edit or save a file to create a local checkpoint.
          </li>
        ) : (
          revisions.map((revision) => (
            <li key={revision.id} className="rounded-md border border-nuriteo-line bg-nuriteo-panel/50 p-2">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate font-mono text-xs text-nuriteo-ink" title={model.displayPath(revision.path)}>
                    {model.displayPath(revision.path)}
                  </p>
                  <p className="mt-0.5 text-[10px] text-nuriteo-muted">
                    {revision.kind === "save" ? "Saved" : "Edited"} · {formatRevisionTime(revision.timestamp)}
                  </p>
                </div>
                <span className="shrink-0 rounded border border-nuriteo-line px-1.5 py-0.5 text-[10px] text-nuriteo-muted">
                  {revision.kind}
                </span>
              </div>
              <div className="mt-2 flex gap-1" role="group" aria-label={`Actions for ${model.displayPath(revision.path)}`}>
                <button type="button" className="btn-small" onClick={() => model.openHistoryDiff(revision)}>
                  Compare
                </button>
                <button type="button" className="btn-small btn-ghost" onClick={() => model.restoreHistoryRevision(revision)}>
                  Restore
                </button>
              </div>
            </li>
          ))
        )}
      </ol>
    </aside>
  );
}

function formatRevisionTime(timestamp: number): string {
  return REVISION_TIME_FORMATTER.format(timestamp);
}
