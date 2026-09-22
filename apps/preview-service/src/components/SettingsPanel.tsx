import type { PreviewControllerModel } from "../hooks/usePreviewController";
import type { ColorTheme, SaveTrigger } from "../lib/settings";

export function SettingsPanel({ model }: { model: PreviewControllerModel }) {
  const { settings, updateSettings, changeStatus } = model;

  return (
    <aside className="flex h-full min-h-0 min-w-0 flex-col border-r border-cargo-line bg-cargo-elevated/60" aria-label="Settings">
      <div className="border-b border-cargo-line px-3 py-2">
        <h2 className="text-[11px] font-semibold tracking-[0.14em] text-cargo-muted uppercase">Settings</h2>
      </div>
      <div className="min-h-0 flex-1 space-y-4 overflow-auto p-3 text-xs">
        <label className="block space-y-1">
          <span className="text-cargo-muted">Theme</span>
          <select
            className="w-full rounded-md border border-cargo-line bg-cargo-panel px-2 py-1.5 text-cargo-ink"
            value={settings.theme}
            onChange={(event) => updateSettings({ theme: event.target.value as ColorTheme })}
          >
            <option value="dark">Dark</option>
            <option value="light">Light</option>
          </select>
        </label>

        <label className="block space-y-1">
          <span className="text-cargo-muted">Editor font size</span>
          <input
            type="range"
            min={11}
            max={20}
            value={settings.fontSize}
            onChange={(event) => updateSettings({ fontSize: Number(event.target.value) })}
            className="w-full"
          />
          <span className="font-mono text-cargo-ink">{settings.fontSize}px</span>
        </label>

        <label className="block space-y-1">
          <span className="text-cargo-muted">Save trigger</span>
          <select
            className="w-full rounded-md border border-cargo-line bg-cargo-panel px-2 py-1.5 text-cargo-ink"
            value={settings.saveTrigger}
            onChange={(event) => updateSettings({ saveTrigger: event.target.value as SaveTrigger })}
          >
            <option value="autosave">Autosave while typing</option>
            <option value="manual">Save on ⌘S only</option>
          </select>
        </label>

        <div className="rounded-lg border border-cargo-line bg-cargo-panel p-3">
          <p className="font-semibold tracking-wide text-cargo-muted uppercase">Working tree</p>
          <p className="mt-1 text-cargo-ink">
            {changeStatus.hasGitMarker ? "Git marker present" : "No .git marker (local dirty tracking)"}
          </p>
          <p className="mt-2 text-cargo-muted">Dirty files: {changeStatus.dirty.length}</p>
          <ul className="mt-1 max-h-32 space-y-0.5 overflow-auto font-mono text-[10px] text-cargo-ink">
            {changeStatus.dirty.map((path) => (
              <li key={path}>{model.displayPath(path)}</li>
            ))}
          </ul>
        </div>
      </div>
    </aside>
  );
}
