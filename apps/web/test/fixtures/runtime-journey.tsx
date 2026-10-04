import React, { useState } from "react";
import { createRoot } from "react-dom/client";

import { ProjectIdeShell } from "../../src/app/(authenticated)/projects/project-ide-shell.tsx";

declare global {
  interface Window { __nuriteoRuntimeProbe: { activeWorkers: number; createdWorkers: number; committedVersion?: number; committedEtag?: string; reloads: number } }
}

const NativeWorker = globalThis.Worker;
class TrackingWorker extends NativeWorker {
  #active = true;

  constructor(scriptURL: string | URL, options?: WorkerOptions) {
    super(scriptURL, options);
    window.__nuriteoRuntimeProbe.activeWorkers += 1;
    window.__nuriteoRuntimeProbe.createdWorkers += 1;
  }

  override terminate(): void {
    if (this.#active) {
      this.#active = false;
      window.__nuriteoRuntimeProbe.activeWorkers -= 1;
    }
    super.terminate();
  }
}

window.__nuriteoRuntimeProbe = { activeWorkers: 0, createdWorkers: 0, reloads: 0 };
Object.defineProperty(globalThis, "Worker", { configurable: true, value: TrackingWorker });

const project = {
  id: "0199ee6c-c777-7000-8000-00000000b002",
  ownerType: "user" as const,
  ownerId: "0199ee6c-c777-7000-8000-00000000b001",
  storageScopeId: "0199ee6c-c777-7000-8000-00000000b001",
  slug: "runtime-journey",
  name: "Runtime Journey",
  state: "active" as const,
  createdAt: "2026-10-04T00:00:00Z",
  updatedAt: "2026-10-04T00:00:00Z",
  archivedAt: null,
  version: 1
};

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

function Fixture() {
  const [etag, setEtag] = useState('"project-v1"');
  return <ProjectIdeShell
      previewConfiguration={previewConfiguration}
      project={project}
      projectEtag={etag}
      onProjectCommit={({ projectEtag, projectVersion }) => {
        setEtag(projectEtag);
        window.__nuriteoRuntimeProbe.committedEtag = projectEtag;
        window.__nuriteoRuntimeProbe.committedVersion = projectVersion;
      }}
      onProjectReload={() => { window.__nuriteoRuntimeProbe.reloads += 1; }}
      workspaceScope={project.ownerId}
    />;
}

createRoot(document.getElementById("root")!).render(<Fixture />);
