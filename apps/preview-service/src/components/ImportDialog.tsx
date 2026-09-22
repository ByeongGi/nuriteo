import { useState } from "react";
import { Dialog } from "@base-ui/react/dialog";
import type { TemplateId } from "@cargo-container/browser-host";
import type { PreviewControllerModel } from "../hooks/usePreviewController";

const TEMPLATES: Array<{ id: TemplateId; title: string; blurb: string }> = [
  { id: "vite-react", title: "Vite + React + TS", blurb: "Recommended create-vite react-ts path" },
  { id: "next-app", title: "Next.js App Router", blurb: "App Router starter (preview adapter)" },
  { id: "vite-ts", title: "Vite + TypeScript", blurb: "Vanilla TypeScript starter" },
  { id: "minimal-npm", title: "Minimal Vite (npm)", blurb: "Smallest Vite app" },
  { id: "minimal-pnpm", title: "Minimal Vite (pnpm)", blurb: "Smallest Vite app" }
];

export function ImportDialog({ model }: { model: PreviewControllerModel }) {
  const [githubUrl, setGithubUrl] = useState("");
  const [pm, setPm] = useState<"" | "npm" | "pnpm" | "yarn">("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const applyPm = () => {
    model.setPackageManagerOverride(pm || null);
  };

  const run = async (action: () => Promise<unknown> | unknown) => {
    setBusy(true);
    setError(null);
    try {
      applyPm();
      await action();
      model.setImportOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog.Root open={model.importOpen} onOpenChange={model.setImportOpen}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-black/65 backdrop-blur-[2px]" />
        <Dialog.Popup className="fixed top-1/2 left-1/2 z-50 w-[min(560px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-cargo-line bg-cargo-panel p-5 shadow-[var(--shadow)] outline-none">
          <header className="mb-4">
            <Dialog.Title className="text-lg font-semibold text-cargo-ink">Open a project</Dialog.Title>
            <Dialog.Description className="mt-1 text-sm text-cargo-muted">
              Start from a template, upload a zip, or import a public GitHub repo.
            </Dialog.Description>
          </header>

          <div className="grid grid-cols-2 gap-2">
            {TEMPLATES.map((template) => (
              <button
                key={template.id}
                type="button"
                disabled={busy}
                className="rounded-xl border border-cargo-line bg-cargo-panel-2 px-3 py-3 text-left transition hover:border-cargo-accent/60 hover:bg-cargo-elevated disabled:opacity-50"
                data-template={template.id}
                onClick={() => void run(async () => {
                  model.loadTemplate(template.id);
                  await model.runPreview();
                })}
              >
                <strong className="block text-sm text-cargo-ink">{template.title}</strong>
                <span className="mt-1 block text-xs text-cargo-muted">{template.blurb}</span>
              </button>
            ))}
          </div>

          <label className="mt-4 block text-xs text-cargo-muted">
            <span className="mb-1.5 block font-medium tracking-wide uppercase">Package manager</span>
            <select
              id="dialog-pm"
              className="w-full rounded-lg border border-cargo-line bg-cargo-elevated px-3 py-2 text-sm text-cargo-ink outline-none focus:border-cargo-accent"
              value={pm}
              onChange={(event) => {
                const value = event.target.value as "" | "npm" | "pnpm" | "yarn";
                setPm(value);
                model.setPackageManagerOverride(value || null);
              }}
            >
              <option value="">Auto-detect</option>
              <option value="npm">npm</option>
              <option value="pnpm">pnpm</option>
              <option value="yarn">Yarn v1</option>
            </select>
          </label>

          <label className="mt-4 block text-xs text-cargo-muted">
            <span className="mb-1.5 block font-medium tracking-wide uppercase">GitHub URL</span>
            <div className="flex gap-2">
              <input
                id="github-input"
                type="url"
                placeholder="https://github.com/owner/repo"
                className="min-w-0 flex-1 rounded-lg border border-cargo-line bg-cargo-elevated px-3 py-2 text-sm text-cargo-ink outline-none focus:border-cargo-accent"
                value={githubUrl}
                onChange={(event) => setGithubUrl(event.target.value)}
              />
              <button
                id="import-github"
                type="button"
                className="btn-accent"
                disabled={busy || !githubUrl.trim()}
                onClick={() => void run(() => model.importGitHub(githubUrl.trim()))}
              >
                Import
              </button>
            </div>
          </label>

          <label className="mt-4 block text-xs text-cargo-muted">
            <span className="mb-1.5 block font-medium tracking-wide uppercase">Zip upload</span>
            <input
              id="zip-input"
              type="file"
              accept=".zip,application/zip"
              disabled={busy}
              className="block w-full rounded-lg border border-dashed border-cargo-line-strong bg-cargo-elevated px-3 py-3 text-sm file:mr-3 file:rounded-md file:border-0 file:bg-cargo-accent file:px-3 file:py-1.5 file:text-xs file:font-semibold file:text-cargo-accent-ink"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (!file) return;
                void run(() => model.importZipFile(file)).finally(() => {
                  event.target.value = "";
                });
              }}
            />
          </label>

          {error ? (
            <p className="mt-3 rounded-lg border border-rose-800/50 bg-rose-950/40 px-3 py-2 text-xs text-cargo-bad">
              {error}
            </p>
          ) : null}

          <footer className="mt-5 flex justify-end">
            <Dialog.Close className="btn-ghost" disabled={busy}>
              Close
            </Dialog.Close>
          </footer>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
