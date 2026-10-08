import React from "react";
import { createRoot } from "react-dom/client";

import { PublishedExamplePreview } from "../../src/app/examples/_components/published-example-preview.tsx";

declare global {
  interface Window {
    __nuriteoPublicPreviewProbe: { activeWorkers: number; createdWorkers: number };
  }
}

const NativeWorker = globalThis.Worker;
class TrackingWorker extends NativeWorker {
  #active = true;

  constructor(scriptURL: string | URL, options?: WorkerOptions) {
    super(scriptURL, options);
    window.__nuriteoPublicPreviewProbe.activeWorkers += 1;
    window.__nuriteoPublicPreviewProbe.createdWorkers += 1;
  }

  override terminate(): void {
    if (this.#active) {
      this.#active = false;
      window.__nuriteoPublicPreviewProbe.activeWorkers -= 1;
    }
    super.terminate();
  }
}

window.__nuriteoPublicPreviewProbe = { activeWorkers: 0, createdWorkers: 0 };
Object.defineProperty(globalThis, "Worker", { configurable: true, value: TrackingWorker });

const previewConfiguration = location.hostname === "app.localhost"
  ? {
      status: "enabled" as const,
      applicationOrigin: location.origin,
      baseDomain: "preview.localhost",
      protocol: location.protocol as "http:" | "https:",
      publicPort: location.port
    }
  : {
      status: "disabled" as const,
      code: "PREVIEW_CONFIGURATION_INVALID" as const,
      message: "Preview origin configuration is invalid."
    };

createRoot(document.getElementById("root")!).render(
  <PublishedExamplePreview
    example={{
      publicId: "ExESEhISEhISEhISEhISEhISEhISEhISEhISEhISEgA",
      name: "Public Preview fixture",
      visibility: "public",
      versionNumber: 3,
      publishedAt: "2026-10-08T00:00:00Z"
    }}
    previewConfiguration={previewConfiguration}
  />
);
