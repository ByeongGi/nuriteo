import React from "react";
import { createRoot } from "react-dom/client";

import { ProjectIdeShell } from "../../src/app/(authenticated)/projects/project-ide-shell.tsx";
import type {
  RuntimeAdapter,
  RuntimeDiagnostic,
  RuntimeRecoveryActionKind,
  RuntimeViewState,
  RuntimeWorkspaceState
} from "../../src/runtime/runtime-adapter.ts";
import type { SubdomainPreviewBridge } from "../../src/runtime/subdomain-preview-bridge.ts";

const project = {
  id: "0199ee6c-c777-7000-8000-00000000c002",
  ownerType: "user" as const,
  ownerId: "0199ee6c-c777-7000-8000-00000000c001",
  storageScopeId: "0199ee6c-c777-7000-8000-00000000c001",
  slug: "runtime-recovery",
  name: "Runtime Recovery",
  state: "active" as const,
  createdAt: "2026-10-04T00:00:00Z",
  updatedAt: "2026-10-04T00:00:00Z",
  archivedAt: null,
  version: 1
};

type FixtureMode = "failure" | "unmount";
interface FixtureControl {
  failPreview(): void;
  resolvePendingBridge(): void;
  snapshot(): { bridgeAttempts: number; bridgeCreationPending: boolean; disposedBridges: number };
  unmount(): void;
}

const mode: FixtureMode = new URLSearchParams(location.search).get("mode") === "unmount" ? "unmount" : "failure";
let lazyAttempts = 0;
let bridgeAttempts = 0;
let bridgeCreationPending = false;
let disposedBridges = 0;
let pendingBridgeResolve: (() => void) | undefined;
const fixture = createRecoveryFixtureAdapter(mode === "unmount" ? "writer" : "conflict");
const root = createRoot(document.getElementById("root")!);

root.render(
  <ProjectIdeShell
    assetRevision={"a".repeat(64)}
    previewBridgeFactory={createFixtureBridge}
    previewConfiguration={{
      status: "enabled",
      applicationOrigin: location.origin,
      baseDomain: "preview.localhost",
      protocol: "http:",
      publicPort: location.port
    }}
    project={project}
    runtimeFeatureLoader={async () => {
      lazyAttempts += 1;
      if (mode === "failure" && lazyAttempts === 1) throw new Error("simulated lazy chunk failure");
      return { createRuntimeAdapter: () => fixture.adapter } as unknown as typeof import("../../src/runtime/runtime-adapter.ts");
    }}
    workspaceScope={project.ownerId}
  />
);

const fixtureWindow = window as Window & { __runtimeRecoveryFixture?: FixtureControl };
fixtureWindow.__runtimeRecoveryFixture = {
  failPreview: fixture.failPreview,
  resolvePendingBridge() { pendingBridgeResolve?.(); },
  snapshot() { return { bridgeAttempts, bridgeCreationPending, disposedBridges }; },
  unmount() { root.unmount(); }
};

async function createFixtureBridge(): Promise<SubdomainPreviewBridge> {
  bridgeAttempts += 1;
  if (mode === "failure" && bridgeAttempts === 2) {
    throw new Error("simulated replacement bridge creation failure");
  }
  if (mode === "unmount") {
    bridgeCreationPending = true;
    return await new Promise<SubdomainPreviewBridge>((resolve) => {
      pendingBridgeResolve = () => {
        pendingBridgeResolve = undefined;
        bridgeCreationPending = false;
        resolve(makeFixtureBridge());
      };
    });
  }
  return makeFixtureBridge();
}

function makeFixtureBridge(): SubdomainPreviewBridge {
  return {
    attach() {},
    async dispose() { disposedBridges += 1; },
    hotUpdate() {},
    url: "about:blank"
  };
}

function createRecoveryFixtureAdapter(initialDraftAccess: "conflict" | "writer"): { adapter: RuntimeAdapter; failPreview(): void } {
  const listeners = new Set<(state: RuntimeViewState) => void>();
  const workspaceText = new Map([["src/message.ts", 'export const label = "initial";\n']]);
  let quotaArmed = true;
  let state = baseState();

  function emit(next: RuntimeViewState) {
    state = next;
    for (const listener of listeners) listener(copyState());
  }

  function copyState(): RuntimeViewState {
    return { ...state, diagnostics: state.diagnostics.map((diagnostic) => ({ ...diagnostic, actions: [...diagnostic.actions] })) };
  }

  function previewFailureDiagnostic(): RuntimeDiagnostic {
    return {
      code: "RUNTIME_PREVIEW_FAILED",
      severity: "error",
      message: "The Preview process stopped before it became ready.",
      actions: [{ kind: "retry", label: "Retry Preview" }]
    };
  }

  const workspaceState = (): RuntimeWorkspaceState => ({
    status: "ready",
    projectId: project.id,
    root: `/workspace/projects/${project.id}`,
    files: [{ kind: "text", name: "message.ts", path: "src/message.ts", sizeBytes: new TextEncoder().encode(workspaceText.get("src/message.ts")).byteLength }],
    totalBytes: new TextEncoder().encode(workspaceText.get("src/message.ts")).byteLength,
    errorCode: null
  });

  const adapter: RuntimeAdapter = {
    async mount() {
      emit({
        ...baseState(),
        generation: 1,
        lifecycle: "ready",
        localDraftAccess: initialDraftAccess,
        diagnostics: initialDraftAccess === "conflict" ? [writerDiagnostic()] : []
      });
    },
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getState: copyState,
    terminal: {
      run: async () => ({ exitCode: 0 }),
      input: () => true,
      resize() {},
      signal: () => true,
      close: () => true,
      activeCount: () => 0
    },
    recovery: {
      async run(kind: RuntimeRecoveryActionKind) {
        if (kind === "resolve-writer-conflict") {
          emit({ ...state, diagnostics: [], localDraftAccess: "writer" });
        } else if (kind === "clear-cache") {
          quotaArmed = false;
          emit({ ...state, diagnostics: [] });
        } else if (kind === "retry") {
          emit({ ...state, diagnostics: [], workflowPhase: "hmr_connected", hmrState: "connected", previewUrl: "/__internal-preview/" });
        }
        return copyState();
      }
    },
    workflow: {
      async start() {
        emit({ ...state, diagnostics: [], workflowPhase: "hmr_connected", hmrState: "connected", previewUrl: "/__internal-preview/" });
        return copyState();
      },
      stopPreview: () => true,
      restart: async () => copyState(),
      dispose: async () => undefined
    },
    workspace: {
      materializeTemplate: async () => workspaceState(),
      materializeBundle: async () => workspaceState(),
      exportBundleFiles: () => [],
      snapshotBundleFiles: () => ({ revision: 0, files: [] }),
      currentRevision: () => 0,
      getState: workspaceState,
      readText(path) {
        const content = workspaceText.get(path);
        if (content === undefined) throw new Error("missing file");
        return content;
      },
      writeText(path, content) {
        if (quotaArmed && content.includes("quota-trigger")) {
          const diagnostic: RuntimeDiagnostic = {
            code: "EOPFSQUOTA",
            severity: "error",
            message: "Local package cache is full.",
            actions: [
              { kind: "clear-cache", label: "Clear package cache" },
              { kind: "retry", label: "Retry Preview" }
            ]
          };
          emit({ ...state, diagnostics: [diagnostic], workflowPhase: "failed" });
          throw new Error("quota exceeded");
        }
        workspaceText.set(path, content);
        return copyState();
      }
    },
    async dispose() { emit(baseState()); }
  };

  return {
    adapter,
    failPreview() { emit({ ...state, diagnostics: [previewFailureDiagnostic()], workflowPhase: "failed" }); }
  };
}

function baseState(): RuntimeViewState {
  return {
    generation: 0,
    lifecycle: "idle",
    projectId: project.id,
    workflowPhase: "idle",
    hmrState: "idle",
    previewUrl: null,
    diagnostics: [],
    localDraftAccess: "none",
    terminalProcessCount: 0
  };
}

function writerDiagnostic(): RuntimeDiagnostic {
  return {
    code: "ELEASEHELD",
    severity: "error",
    message: "Another tab owns this Local Draft writer lease.",
    actions: [{ kind: "resolve-writer-conflict", label: "Take over writer lease" }]
  };
}
