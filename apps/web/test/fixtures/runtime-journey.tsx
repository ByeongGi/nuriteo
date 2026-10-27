import React, { useState } from "react";
import { createRoot } from "react-dom/client";

import { ProjectIdeShell } from "../../src/projects/project-ide-shell.tsx";
import {
  createRuntimeAdapter as createBrowserRuntimeAdapter,
  type RuntimeAdapter
} from "../../src/runtime/runtime-adapter.ts";
import {
  createSubdomainPreviewBridge,
  type SubdomainPreviewBridge
} from "../../src/runtime/subdomain-preview-bridge.ts";

declare global {
  interface Window { __nuriteoRuntimeProbe: { activeWorkers: number; adapter?: RuntimeAdapter; createdWorkers: number; committedVersion?: number; committedEtag?: string; reloads: number; restoreMode: "download-failure" | "intervening" | "materialization-failure" | "not-saved" | "success"; runtimeActiveWorkers: number; runtimeCreatedWorkers: number } }
}

const NativeWorker = globalThis.Worker;
class TrackingWorker extends NativeWorker {
  #active = true;
  #runtimeWorker: boolean;

  constructor(scriptURL: string | URL, options?: WorkerOptions) {
    super(scriptURL, options);
    this.#runtimeWorker = /\/runtime\/[^/]+\/(?:system|process)-worker\.js$/u.test(String(scriptURL));
    window.__nuriteoRuntimeProbe.activeWorkers += 1;
    window.__nuriteoRuntimeProbe.createdWorkers += 1;
    if (this.#runtimeWorker) {
      window.__nuriteoRuntimeProbe.runtimeActiveWorkers += 1;
      window.__nuriteoRuntimeProbe.runtimeCreatedWorkers += 1;
    }
  }

  override terminate(): void {
    if (this.#active) {
      this.#active = false;
      window.__nuriteoRuntimeProbe.activeWorkers -= 1;
      if (this.#runtimeWorker) window.__nuriteoRuntimeProbe.runtimeActiveWorkers -= 1;
    }
    super.terminate();
  }
}

window.__nuriteoRuntimeProbe = { activeWorkers: 0, createdWorkers: 0, reloads: 0, restoreMode: "not-saved", runtimeActiveWorkers: 0, runtimeCreatedWorkers: 0 };
Object.defineProperty(globalThis, "Worker", { configurable: true, value: TrackingWorker });

const project = {
  id: "0199ee6c-c777-7000-8000-00000000b002",
  ownerType: "user" as const,
  ownerId: "0199ee6c-c777-7000-8000-00000000b001",
  storageScopeId: "0199ee6c-c777-7000-8000-00000000b001",
  slug: "runtime-journey",
  name: "Runtime Journey",
  templateId: "vite-react" as const,
  state: "active" as const,
  createdAt: "2026-10-04T00:00:00Z",
  updatedAt: "2026-10-04T00:00:00Z",
  archivedAt: null,
  version: 1
};

const previewConfiguration = {
  status: "enabled" as const,
  applicationOrigin: location.origin,
  baseDomain: "preview.localhost",
  protocol: location.protocol as "http:" | "https:",
  publicPort: location.port
};

function Fixture() {
  const [etag, setEtag] = useState('"project-v1"');
  return <ProjectIdeShell
      previewBridgeFactory={createFixturePreviewBridge}
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
      runtimeFeatureLoader={loadRuntimeFeature}
      workspaceScope={project.ownerId}
    />;
}

async function loadRuntimeFeature() {
  return {
    createRuntimeAdapter() {
      const adapter = createBrowserRuntimeAdapter();
      window.__nuriteoRuntimeProbe.adapter = adapter;
      return adapter;
    }
  };
}

async function createFixturePreviewBridge(
  options: Parameters<typeof createSubdomainPreviewBridge>[0]
): Promise<SubdomainPreviewBridge> {
  if (location.hostname === "app.localhost") {
    return createSubdomainPreviewBridge(options);
  }
  return {
    attach() {},
    async dispose() {},
    hotUpdate() {},
    url: options.internalPreviewUrl
  };
}

createRoot(document.getElementById("root")!).render(<Fixture />);

async function loadResumeFeature() {
  return {
    async resumeProjectContent() {
      const mode = window.__nuriteoRuntimeProbe.restoreMode;
      if (mode === "not-saved") throw Object.assign(new Error("fixture project is not saved"), { code: "RESUME_NOT_SAVED" });
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
