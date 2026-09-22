import { Group, Panel, Separator } from "react-resizable-panels";
import { usePreviewController } from "./hooks/usePreviewController";
import { TopBar } from "./components/TopBar";
import { WelcomeOverlay } from "./components/WelcomeOverlay";
import { ImportDialog } from "./components/ImportDialog";
import { ActivityBar } from "./components/ActivityBar";
import { FileTree } from "./components/FileTree";
import { SearchPanel } from "./components/SearchPanel";
import { PortsPanel } from "./components/PortsPanel";
import { SettingsPanel } from "./components/SettingsPanel";
import { ScmPanel } from "./components/ScmPanel";
import { OutlinePanel } from "./components/OutlinePanel";
import { LocalHistoryPanel } from "./components/LocalHistoryPanel";
import { CodeEditor } from "./components/CodeEditor";
import { PreviewPane } from "./components/PreviewPane";
import { BottomDock } from "./components/BottomDock";
import { CommandPalette } from "./components/CommandPalette";
import { DiffPane } from "./components/DiffPane";

export default function App() {
  const model = usePreviewController();
  const showSidebar = model.settings.showSidebar && !model.zenMode;
  const showPreview = model.settings.showPreview && !model.zenMode;
  const showTerminal = model.settings.showTerminal && !model.zenMode;
  const showActivity = !model.zenMode;

  const sidebar = (() => {
    switch (model.sidebarView) {
      case "search":
        return <SearchPanel model={model} />;
      case "scm":
        return <ScmPanel model={model} />;
      case "outline":
        return <OutlinePanel model={model} />;
      case "timeline":
        return <LocalHistoryPanel model={model} />;
      case "ports":
        return <PortsPanel model={model} />;
      case "settings":
        return <SettingsPanel model={model} />;
      case "explorer":
      default:
        return <FileTree model={model} />;
    }
  })();

  return (
    <div
      id="app-shell"
      className="relative flex h-full min-h-0 flex-col bg-[radial-gradient(900px_420px_at_0%_0%,rgba(224,154,69,0.12),transparent_55%),radial-gradient(700px_360px_at_100%_0%,rgba(80,120,180,0.08),transparent_50%),var(--bg)]"
      onDragOver={(event) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
      }}
      onDrop={(event) => {
        event.preventDefault();
        void model.handleDroppedFiles(event.dataTransfer.files);
      }}
    >
      {model.zenMode ? null : <TopBar model={model} />}
      {model.zenMode ? (
        <div className="flex items-center justify-between border-b border-cargo-line px-3 py-1 text-xs text-cargo-muted">
          <span>Zen mode</span>
          <button type="button" className="btn-small" onClick={() => model.toggleZenMode()}>Exit Zen</button>
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1">
        {showActivity ? <ActivityBar active={model.sidebarView} onSelect={model.setSidebarView} /> : null}

        <Group
          id="ide-vertical"
          orientation="vertical"
          className="min-h-0 min-w-0 flex-1"
          defaultLayout={{ main: 74, dock: 26 }}
        >
          <Panel id="main" minSize="30%" defaultSize="74%" className="min-h-0" collapsible={!showTerminal}>
            <Group
              id="ide-horizontal"
              orientation="horizontal"
              className="h-full min-h-0"
              defaultLayout={{ files: 18, editor: 44, preview: 38 }}
            >
              {showSidebar ? (
                <>
                  <Panel id="files" minSize="12%" defaultSize="18%" className="min-w-0">
                    {sidebar}
                  </Panel>
                  <Separator id="sep-files" className="ide-separator" />
                </>
              ) : null}
              <Panel id="editor" minSize="20%" defaultSize={showPreview && !model.diffView ? "44%" : "82%"} className="min-w-0">
                <CodeEditor model={model} />
              </Panel>
              {model.diffView ? (
                <>
                  <Separator id="sep-diff" className="ide-separator" />
                  <Panel id="diff" minSize="18%" defaultSize="38%" className="min-w-0">
                    <DiffPane model={model} />
                  </Panel>
                </>
              ) : showPreview ? (
                <>
                  <Separator id="sep-preview" className="ide-separator" />
                  <Panel id="preview" minSize="18%" defaultSize="38%" className="min-w-0">
                    <PreviewPane model={model} />
                  </Panel>
                </>
              ) : null}
            </Group>
          </Panel>
          {showTerminal ? (
            <>
              <Separator id="sep-dock" className="ide-separator ide-separator-horizontal" />
              <Panel id="dock" minSize="12%" defaultSize="26%" className="min-h-0">
                <BottomDock model={model} />
              </Panel>
            </>
          ) : null}
        </Group>
      </div>

      <WelcomeOverlay model={model} />
      <ImportDialog model={model} />
      <CommandPalette
        open={model.paletteOpen}
        mode={model.paletteMode}
        filePaths={model.filePaths}
        onClose={() => model.setPaletteOpen(false)}
        onRun={model.runCommand}
        onOpenFile={(path) => model.openFile(path)}
      />

      <div className="legacy-controls hidden" hidden>
        <select id="template-select" aria-label="Project template" defaultValue="vite-react">
          <option value="vite-react">Vite + React + TS</option>
          <option value="next-app">Next.js App Router</option>
          <option value="vite-ts">Vite + TypeScript</option>
          <option value="minimal-npm">Minimal Vite (npm)</option>
          <option value="minimal-pnpm">Minimal Vite (pnpm)</option>
        </select>
        <button id="load-template" type="button">Load template</button>
        <select id="pm-override" aria-label="Package manager override" defaultValue="">
          <option value="">auto</option>
          <option value="npm">npm</option>
          <option value="pnpm">pnpm</option>
        </select>
      </div>
    </div>
  );
}
