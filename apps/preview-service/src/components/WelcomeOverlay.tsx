import { FolderInput, Rocket } from "lucide-react";
import type { TemplateId } from "@nuriteo/browser-host";
import type { PreviewControllerModel } from "../hooks/usePreviewController";

const TEMPLATES: Array<{ id: TemplateId; title: string; blurb: string }> = [
  { id: "vite-react", title: "Vite + React + TS", blurb: "create-vite style React TSX starter" },
  { id: "next-app", title: "Next.js App Router", blurb: "App Router starter (preview adapter)" },
  { id: "vite-ts", title: "Vite + TypeScript", blurb: "Vanilla TypeScript + Vite" },
  { id: "minimal-pnpm", title: "Minimal Vite (pnpm)", blurb: "Smallest Vite app using pnpm" },
  { id: "minimal-npm", title: "Minimal Vite (npm)", blurb: "Smallest Vite app using npm" }
];

export function WelcomeOverlay({ model }: { model: PreviewControllerModel }) {
  if (!model.showWelcome) return null;

  return (
    <div
      id="welcome"
      className="absolute inset-0 z-40 flex items-center justify-center bg-[radial-gradient(900px_420px_at_20%_10%,rgba(224,154,69,0.16),transparent_55%),radial-gradient(700px_360px_at_90%_0%,rgba(80,120,180,0.1),transparent_50%),rgba(8,11,16,0.92)] p-6"
      onDragOver={(event) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
      }}
      onDrop={(event) => {
        event.preventDefault();
        void model.handleDroppedFiles(event.dataTransfer.files);
      }}
    >
      <div className="w-full max-w-2xl rounded-2xl border border-nuriteo-line bg-nuriteo-panel/95 p-8 shadow-[var(--shadow)]">
        <div
          aria-hidden
          className="mb-5 size-10 border-2 border-nuriteo-accent"
          style={{
            background:
              "linear-gradient(135deg, transparent 46%, var(--accent) 46% 54%, transparent 54%), linear-gradient(45deg, transparent 46%, var(--accent) 46% 54%, transparent 54%)"
          }}
        />
        <h1 className="text-2xl font-semibold tracking-tight text-nuriteo-ink">Build in the browser</h1>
        <p className="mt-3 text-sm leading-relaxed text-nuriteo-muted">
          NURITEO runs a Node-compatible workspace in Chrome — install, dev server,
          live preview, and edits with HMR.
        </p>

        <div className="mt-6 grid gap-2 sm:grid-cols-2" id="template-gallery" aria-label="Template gallery">
          {TEMPLATES.map((template) => (
            <button
              key={template.id}
              type="button"
              data-template={template.id}
              className="rounded-xl border border-nuriteo-line bg-nuriteo-elevated/80 px-3 py-3 text-left hover:border-nuriteo-accent/50 hover:bg-nuriteo-accent/10"
              onClick={() => {
                model.loadTemplate(template.id);
                model.focusTerminal();
                void model.runPreview().catch(() => undefined);
              }}
            >
              <div className="text-sm font-semibold text-nuriteo-ink">{template.title}</div>
              <div className="mt-1 text-xs text-nuriteo-muted">{template.blurb}</div>
            </button>
          ))}
        </div>

        <div className="mt-6 flex flex-wrap gap-3">
          <button
            id="welcome-start"
            type="button"
            className="btn-primary btn-large"
            onClick={() => void model.startViteReact()}
          >
            <Rocket className="size-4" />
            Start Vite + React + TS
          </button>
          <button
            id="welcome-import"
            type="button"
            className="btn btn-large"
            onClick={() => model.setImportOpen(true)}
          >
            <FolderInput className="size-4" />
            Import project
          </button>
        </div>
        <p className="mt-4 text-xs text-nuriteo-muted">
          Drop a <code className="font-mono">.zip</code> or files into Explorer. Deep links:
          <code className="mx-1 font-mono">?file=src/main.tsx&amp;terminal=dev</code>
          ·
          <code className="mx-1 font-mono">?template=vite-react</code>
          ·
          <code className="ml-1 font-mono">?github=owner/repo</code>
        </p>
      </div>
    </div>
  );
}
