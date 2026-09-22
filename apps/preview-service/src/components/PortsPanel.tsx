import type { PreviewControllerModel } from "../hooks/usePreviewController";

export function PortsPanel({ model }: { model: PreviewControllerModel }) {
  const ports = model.ports;

  return (
    <aside className="flex h-full min-h-0 min-w-0 flex-col border-r border-cargo-line bg-cargo-elevated/60" aria-label="Ports in use">
      <div className="border-b border-cargo-line px-3 py-2">
        <h2 className="text-[11px] font-semibold tracking-[0.14em] text-cargo-muted uppercase">Ports in use</h2>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-2">
        <h3 className="px-2 pb-1 text-[10px] font-semibold tracking-wide text-cargo-muted uppercase">Processes</h3>
        {model.processes.length === 0 ? (
          <p className="px-2 pb-3 text-xs text-cargo-muted">No running terminal processes.</p>
        ) : (
          <ul className="mb-3 space-y-1">
            {model.processes.map((process) => (
              <li key={process.terminalId} className="rounded-md border border-cargo-line bg-cargo-panel px-2.5 py-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate font-mono text-xs text-cargo-ink">{process.command}</span>
                  <button
                    type="button"
                    className="text-[10px] text-red-400 hover:text-red-300"
                    onClick={() => model.controller.signalShell("SIGKILL", process.terminalId)}
                  >
                    Kill
                  </button>
                </div>
                <span className="block truncate font-mono text-[10px] text-cargo-muted">{process.cwd}</span>
              </li>
            ))}
          </ul>
        )}
        <h3 className="px-2 pb-1 text-[10px] font-semibold tracking-wide text-cargo-muted uppercase">Ports</h3>
        {ports.length === 0 ? (
          <p className="px-2 py-3 text-xs text-cargo-muted">No open ports. Run preview to start a server.</p>
        ) : (
          <ul className="space-y-1">
            {ports.map((entry) => {
              const active = model.activePortId === entry.id;
              return (
                <li key={entry.id}>
                  <div
                    className={`flex w-full flex-col rounded-md border px-2.5 py-2 text-left ${
                      active
                        ? "border-cargo-accent/50 bg-cargo-accent/10"
                        : "border-cargo-line bg-cargo-panel hover:bg-cargo-panel-2"
                    }`}
                  >
                    <button type="button" className="text-left" onClick={() => model.selectPort(entry.id)}>
                      <span className="font-mono text-xs text-cargo-accent-strong">:{entry.port}</span>
                    </button>
                    <span className="text-[11px] text-cargo-muted">{entry.label}</span>
                    <span className="truncate font-mono text-[10px] text-cargo-muted">{entry.path}</span>
                    <button
                      type="button"
                      className="mt-1 self-end text-[10px] text-red-400 hover:text-red-300"
                      onClick={() => model.stopPort(entry.port)}
                    >
                      Stop process
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        {model.snapshot.previewUrl ? (
          <button
            type="button"
            className="btn-small mt-3 w-full"
            onClick={() => model.addPreviewPathTab("/")}
          >
            Add preview tab
          </button>
        ) : null}
      </div>
    </aside>
  );
}
