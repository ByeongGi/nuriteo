import { useEffect, useState } from "react";
import { ExternalLink, RefreshCw } from "lucide-react";
import type { PreviewControllerModel } from "../hooks/usePreviewController";

async function waitForServiceWorkerController(): Promise<void> {
  if (!("serviceWorker" in navigator)) return;
  await navigator.serviceWorker.ready;
  if (navigator.serviceWorker.controller) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => resolve(), 1500);
    navigator.serviceWorker.addEventListener(
      "controllerchange",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true }
    );
  });
}

export function PreviewPane({ model }: { model: PreviewControllerModel }) {
  const previewUrl = model.activePreviewUrl;
  const [frameSrc, setFrameSrc] = useState<string | null>(null);
  const [pathDraft, setPathDraft] = useState("/");
  const [softToken, setSoftToken] = useState(0);

  useEffect(() => {
    if (!previewUrl) {
      setPathDraft("/");
      return;
    }
    try {
      const url = new URL(previewUrl, window.location.origin);
      setPathDraft(`${url.pathname.replace(/^.*\/__preview\/[^/]+\/\d+/, "") || "/"}${url.search}`);
    } catch {
      setPathDraft("/");
    }
  }, [previewUrl, model.activePortId]);

  useEffect(() => {
    let cancelled = false;
    if (!previewUrl) {
      setFrameSrc(null);
      return;
    }
    void (async () => {
      await waitForServiceWorkerController();
      if (cancelled) return;
      // Soft reload bumps softToken / softRefreshToken; hard refresh uses frameNonce.
      const glue = previewUrl.includes("?") ? "&" : "?";
      setFrameSrc(
        `${previewUrl}${glue}t=${Date.now()}-${model.frameNonce}-${model.softRefreshToken}-${softToken}`
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [previewUrl, model.frameNonce, model.softRefreshToken, softToken]);

  const tabs = model.ports;

  return (
    <section className="flex h-full min-h-0 min-w-0 flex-col bg-cargo-panel" aria-label="Live preview">
      {tabs.length > 1 ? (
        <div className="flex items-center gap-1 overflow-x-auto border-b border-cargo-line px-2 py-1" aria-label="Preview tabs">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              className={`rounded-md px-2 py-1 text-[11px] ${
                model.activePortId === tab.id
                  ? "bg-cargo-accent/15 text-cargo-accent-strong"
                  : "text-cargo-muted hover:bg-cargo-panel-2"
              }`}
              onClick={() => model.selectPort(tab.id)}
            >
              :{tab.port}{tab.path !== "/" ? tab.path : ""}
            </button>
          ))}
        </div>
      ) : null}

      <div className="flex items-center gap-2 border-b border-cargo-line bg-cargo-elevated/80 px-2 py-1.5">
        <button
          id="preview-refresh"
          type="button"
          className="icon-btn"
          title="Soft reload preview"
          disabled={!previewUrl}
          onClick={() => setSoftToken((value) => value + 1)}
        >
          <RefreshCw className="size-3.5" />
        </button>
        <form
          className="flex min-w-0 flex-1 items-center gap-1"
          onSubmit={(event) => {
            event.preventDefault();
            model.navigatePreviewPath(pathDraft || "/");
            setSoftToken((value) => value + 1);
          }}
        >
          <input
            id="preview-url-input"
            type="text"
            aria-label="Preview path"
            placeholder="/ or /about"
            value={pathDraft}
            disabled={!previewUrl}
            onChange={(event) => setPathDraft(event.target.value)}
            className="min-w-0 flex-1 rounded-md border border-cargo-line bg-cargo-bg px-2.5 py-1.5 font-mono text-xs text-cargo-ink outline-none focus:border-cargo-accent"
          />
        </form>
        <a
          id="preview-open"
          className="icon-btn"
          href={previewUrl || "#"}
          target="_blank"
          rel="noopener noreferrer"
          title="Open preview"
          aria-disabled={previewUrl ? undefined : "true"}
          onClick={(event) => {
            if (!previewUrl) event.preventDefault();
          }}
        >
          <ExternalLink className="size-3.5" />
        </a>
        <p id="preview-url" className="sr-only">{previewUrl || "not connected"}</p>
      </div>

      <div id="preview-stage" className="relative min-h-0 flex-1 bg-[#0a0d12]">
        <iframe
          id="preview-frame"
          title="Project preview"
          src={frameSrc || undefined}
          className={frameSrc ? "absolute inset-0 h-full w-full border-0 bg-white" : "hidden"}
        />
        {!frameSrc ? (
          <div className="absolute inset-0 flex items-center justify-center p-6" id="preview-empty">
            <div className="max-w-sm rounded-2xl border border-cargo-line bg-cargo-elevated/90 px-5 py-4 text-center shadow-[var(--shadow)]">
              <strong className="text-sm text-cargo-ink">Live preview</strong>
              <p className="mt-2 text-xs leading-relaxed text-cargo-muted">
                Run the project to see your app here with HMR.
              </p>
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}
