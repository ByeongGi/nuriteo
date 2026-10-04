import React, { useState } from "react";
import { createRoot } from "react-dom/client";

import { ProjectIdeShell } from "../../src/app/(authenticated)/projects/project-ide-shell.tsx";

declare global {
  interface Window { __nuriteoRuntimeProbe: { activeWorkers: number; createdWorkers: number; committedVersion?: number; committedEtag?: string; reloads: number; restoreMode: "download-failure" | "intervening" | "materialization-failure" | "success" } }
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

window.__nuriteoRuntimeProbe = { activeWorkers: 0, createdWorkers: 0, reloads: 0, restoreMode: "success" };
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
      resumeProjectContentLoader={loadResumeFeature}
      workspaceScope={project.ownerId}
    />;
}

createRoot(document.getElementById("root")!).render(<Fixture />);

async function loadResumeFeature() {
  return {
    async resumeProjectContent() {
      const mode = window.__nuriteoRuntimeProbe.restoreMode;
      if (mode === "download-failure") throw new Error("fixture download failed");
      const bytes = new TextEncoder().encode('export const label = "restored exact head";\n');
      const file = { path: "src/message.ts", kind: "text" as const, executable: false, bytes };
      return {
        descriptor: {
          projectId: project.id,
          projectVersion: mode === "intervening" ? 4 : 3,
          bundleId: "0199ee6c-c777-7000-8000-00000000b005",
          etag: `"content-v${mode === "intervening" ? 4 : 3}-${"a".repeat(43)}"`,
          checksumAlgorithm: "sha-256" as const,
          checksum: "a".repeat(43),
          physicalBytes: bytes.byteLength,
          logicalBytes: bytes.byteLength,
          fileCount: mode === "materialization-failure" ? 2 : 1,
          format: "project-bundle-v1" as const,
          downloadUrl: "/fixture/content"
        },
        files: mode === "materialization-failure" ? [file, file] : [file]
      };
    }
  };
}
