import { Cloud, Download, FolderInput, Play, RefreshCw, Rocket, Hammer, Maximize2 } from "lucide-react";
import { AppMenuBar } from "./AppMenuBar";
import { StatusPill, phaseTone } from "./StatusPill";
import type { PreviewControllerModel } from "../hooks/usePreviewController";
import { NotificationCenter } from "./NotificationCenter";

export function TopBar({ model }: { model: PreviewControllerModel }) {
  const {
    snapshot,
    previewLive,
    hasProject,
    startViteReact,
    runPreview,
    runBuild,
    restartDev,
    exportZip,
    setImportOpen,
    toggleZenMode,
    changeStatus
  } = model;
  const meta = snapshot.projectId
    ? `${snapshot.source || "project"} · ${snapshot.manager || "auto"}`
    : "No project open";

  return (
    <header className="grid h-14 shrink-0 grid-cols-[minmax(180px,1fr)_auto_minmax(160px,1fr)] items-center gap-3 border-b border-cargo-line bg-cargo-elevated/95 px-3.5">
      <div className="flex min-w-0 items-center gap-2.5">
        <span
          aria-hidden
          className="size-7 shrink-0 border-2 border-cargo-accent"
          style={{
            background:
              "linear-gradient(135deg, transparent 46%, var(--accent) 46% 54%, transparent 54%), linear-gradient(45deg, transparent 46%, var(--accent) 46% 54%, transparent 54%)"
          }}
        />
        <div className="flex min-w-0 flex-col gap-0.5">
          <strong className="text-sm font-semibold text-cargo-ink">Cargo Container</strong>
          <span id="project-meta" className="truncate font-mono text-[11px] font-medium text-cargo-muted">
            {meta}
          </span>
        </div>
        <div className="ml-1 shrink-0 border-l border-cargo-line pl-1">
          <AppMenuBar
            hasProject={hasProject}
            hasSelectedFile={Boolean(model.selectedPath)}
            runCommand={model.runCommand}
            setPaletteMode={model.setPaletteMode}
            setPaletteOpen={model.setPaletteOpen}
          />
        </div>
      </div>

      <nav className="flex flex-wrap items-center justify-center gap-2" aria-label="Project actions">
        <button
          id="start-project"
          type="button"
          className="btn-primary"
          onClick={() => void startViteReact()}
        >
          <Rocket className="size-3.5" />
          Start React TS
        </button>
        <button
          id="run-preview"
          type="button"
          className="btn-accent"
          onClick={() => void runPreview().catch(() => undefined)}
        >
          <Play className="size-3.5" />
          Run preview
        </button>
        <button
          id="run-build"
          type="button"
          className="btn"
          disabled={!hasProject}
          onClick={() => void runBuild().catch(() => undefined)}
        >
          <Hammer className="size-3.5" />
          Build
        </button>
        <button
          id="restart-dev"
          type="button"
          className="btn"
          disabled={!previewLive && snapshot.phase !== "failed"}
          onClick={() => void restartDev().catch(() => undefined)}
        >
          <RefreshCw className="size-3.5" />
          Restart
        </button>
        <button
          id="export-zip"
          type="button"
          className="btn"
          disabled={!snapshot.project}
          onClick={() => {
            try {
              const bytes = exportZip();
              const blob = new Blob([Uint8Array.from(bytes)], { type: "application/zip" });
              const url = URL.createObjectURL(blob);
              const anchor = document.createElement("a");
              anchor.href = url;
              anchor.download = `${snapshot.projectId || "project"}.zip`;
              anchor.click();
              URL.revokeObjectURL(url);
            } catch {
              /* terminal captures via controller events */
            }
          }}
        >
          <Download className="size-3.5" />
          Export
        </button>
        <button
          id="open-import"
          type="button"
          className="btn-ghost"
          onClick={() => setImportOpen(true)}
        >
          <FolderInput className="size-3.5" />
          Import…
        </button>
        <button id="open-cloud-projects" type="button" className="btn-ghost" onClick={() => model.setCloudOpen(true)}>
          <Cloud className="size-3.5" />
          Cloud
        </button>
      </nav>

      <div className="flex items-center justify-end gap-2" aria-live="polite">
        <NotificationCenter model={model} />
        <span className="hidden font-mono text-[11px] text-cargo-muted sm:inline">
          dirty {changeStatus.dirty.length}
        </span>
        <button type="button" className="btn" title="Zen mode" onClick={() => toggleZenMode()}>
          <Maximize2 className="size-3.5" />
          Zen
        </button>
        <StatusPill
          id="phase-status"
          label={snapshot.phase.replaceAll("_", " ")}
          tone={phaseTone(snapshot.phase)}
        />
        <StatusPill
          id="hmr-status"
          label={`HMR ${snapshot.hmrState}`}
          tone="muted"
        />
      </div>
    </header>
  );
}
