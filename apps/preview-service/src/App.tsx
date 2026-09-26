import { lazy, type ReactNode } from "react";
import { Group, Panel, Separator } from "react-resizable-panels";
import { usePreviewController } from "./hooks/usePreviewController";
import { TopBar } from "./components/TopBar";
import { WelcomeOverlay } from "./components/WelcomeOverlay";
import { ActivityBar } from "./components/ActivityBar";
import { FileTree } from "./components/FileTree";
import { PreviewPane } from "./components/PreviewPane";
import { LazyFeatureBoundary } from "./components/LazyFeatureBoundary";
import { BottomDock } from "./components/BottomDock";

const CodeEditor = lazy(() => import("./components/CodeEditor").then(({ CodeEditor }) => ({ default: CodeEditor })));
const DiffPane = lazy(() => import("./components/DiffPane").then(({ DiffPane }) => ({ default: DiffPane })));
const ImportDialog = lazy(() => import("./components/ImportDialog").then(({ ImportDialog }) => ({ default: ImportDialog })));
const CloudProjectsDialog = lazy(() => import("./components/CloudProjectsDialog").then(({ CloudProjectsDialog }) => ({ default: CloudProjectsDialog })));
const CommandPalette = lazy(() => import("./components/CommandPalette").then(({ CommandPalette }) => ({ default: CommandPalette })));
const SearchPanel = lazy(() => import("./components/SearchPanel").then(({ SearchPanel }) => ({ default: SearchPanel })));
const PortsPanel = lazy(() => import("./components/PortsPanel").then(({ PortsPanel }) => ({ default: PortsPanel })));
const SettingsPanel = lazy(() => import("./components/SettingsPanel").then(({ SettingsPanel }) => ({ default: SettingsPanel })));
const ScmPanel = lazy(() => import("./components/ScmPanel").then(({ ScmPanel }) => ({ default: ScmPanel })));
const OutlinePanel = lazy(() => import("./components/OutlinePanel").then(({ OutlinePanel }) => ({ default: OutlinePanel })));
const LocalHistoryPanel = lazy(() => import("./components/LocalHistoryPanel").then(({ LocalHistoryPanel }) => ({ default: LocalHistoryPanel })));
const DeveloperToolsPanel = lazy(() => import("./components/DeveloperToolsPanel").then(({ DeveloperToolsPanel }) => ({ default: DeveloperToolsPanel })));

function feature(name: string, child: ReactNode, fallback = "Loading…") {
  return (
    <LazyFeatureBoundary
      name={name}
      fallback={<div className="flex h-full items-center justify-center p-4 text-xs text-cargo-muted">{fallback}</div>}
    >
      {child}
    </LazyFeatureBoundary>
  );
}
export default function App() {
  const model = usePreviewController();
  const showSidebar = model.settings.showSidebar && !model.zenMode;
  const showPreview = model.settings.showPreview && !model.zenMode;
  const showTerminal = model.settings.showTerminal && !model.zenMode;
  const showActivity = !model.zenMode;

  const sidebar = (() => {
    switch (model.sidebarView) {
      case "search":
        return feature("Search", <SearchPanel model={model} />, "Loading search…");
      case "scm":
        return feature("Source Control", <ScmPanel model={model} />, "Loading source control…");
      case "outline":
        return feature("Outline", <OutlinePanel model={model} />, "Loading outline…");
      case "timeline":
        return feature("Timeline", <LocalHistoryPanel model={model} />, "Loading timeline…");
      case "ports":
        return feature("Ports", <PortsPanel model={model} />, "Loading ports…");
      case "settings":
        return feature("Settings", <SettingsPanel model={model} />, "Loading settings…");
      case "developer-tools":
        return feature("Run and Extensions", <DeveloperToolsPanel />, "Loading developer tools…");
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
                {model.selectedPath
                  ? feature("Code editor", <CodeEditor model={model} />, "Starting editor…")
                  : <section className="flex h-full items-center justify-center px-6 text-sm text-cargo-muted" aria-label="Editor">Select a file from the sidebar to edit.</section>}
              </Panel>
              {model.diffView ? (
                <>
                  <Separator id="sep-diff" className="ide-separator" />
                  <Panel id="diff" minSize="18%" defaultSize="38%" className="min-w-0">
                    {feature("Diff editor", <DiffPane model={model} />, "Loading diff…")}
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
      {model.importOpen ? feature("Project import", <ImportDialog model={model} />) : null}
      {model.cloudOpen ? feature("Cloud Projects", <CloudProjectsDialog model={model} />) : null}
      {model.paletteOpen
        ? feature("Command palette", <CommandPalette
            open
            mode={model.paletteMode}
            filePaths={model.filePaths}
            onClose={() => model.setPaletteOpen(false)}
            onRun={model.runCommand}
            onOpenFile={(path) => model.openFile(path)}
          />)
        : null}

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
          <option value="yarn">Yarn v1</option>
        </select>
      </div>
    </div>
  );
}
