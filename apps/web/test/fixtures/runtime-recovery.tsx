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
  templateId: "vite-react" as const,
  state: "active" as const,
  createdAt: "2026-10-04T00:00:00Z",
  updatedAt: "2026-10-04T00:00:00Z",
  archivedAt: null,
  version: 1
};

type FixtureMode = "failure" | "scale" | "unmount";
interface FixtureControl {
  failPreview(): void;
  resolvePendingBridge(): void;
  snapshot(): { bridgeAttempts: number; bridgeCreationPending: boolean; disposedBridges: number };
  unmount(): void;
}

const requestedMode = new URLSearchParams(location.search).get("mode");
const mode: FixtureMode = requestedMode === "unmount" || requestedMode === "scale" ? requestedMode : "failure";
let lazyAttempts = 0;
let bridgeAttempts = 0;
let bridgeCreationPending = false;
let disposedBridges = 0;
let pendingBridgeResolve: (() => void) | undefined;
const fixture = createRecoveryFixtureAdapter(mode === "failure" ? "conflict" : "writer", mode === "scale");
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
    resumeProjectContentLoader={async () => ({
      async resumeProjectContent() {
        throw Object.assign(new Error("fixture project is not saved"), { code: "RESUME_NOT_SAVED" });
      }
    })}
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

function createRecoveryFixtureAdapter(initialDraftAccess: "conflict" | "writer", withLargeWorkspace: boolean): { adapter: RuntimeAdapter; failPreview(): void } {
  const listeners = new Set<(state: RuntimeViewState) => void>();
  const workspaceText = new Map([["src/message.ts", 'export const label = "initial";\n']]);
  if (withLargeWorkspace) {
    for (let index = 0; index < 2_500; index += 1) {
      const suffix = String(index).padStart(4, "0");
      workspaceText.set(`src/generated/module-${suffix}.ts`, `export const module${suffix} = ${index};\n`);
    }
  }
  let quotaArmed = true;
  let state = baseState();

  function emit(next: RuntimeViewState) {
    state = next;
    for (const listener of listeners) listener(copyState());
  }

  function copyState(): RuntimeViewState {
    return {
      ...state,
      diagnostics: state.diagnostics.map((diagnostic) => ({ ...diagnostic, actions: [...diagnostic.actions] })),
      ports: state.ports.map((port) => ({ ...port })),
      processes: state.processes.map((process) => ({ ...process, argv: [...process.argv] }))
    };
  }

  function previewFailureDiagnostic(): RuntimeDiagnostic {
    return {
      code: "RUNTIME_PREVIEW_FAILED",
      severity: "error",
      message: "The Preview process stopped before it became ready.",
      actions: [{ kind: "retry", label: "Retry Preview" }]
    };
  }

  const workspaceState = (): RuntimeWorkspaceState => {
    let totalBytes = 0;
    const files = Array.from(workspaceText, ([path, content]) => {
      const sizeBytes = new TextEncoder().encode(content).byteLength;
      totalBytes += sizeBytes;
      return { kind: "text" as const, name: path.split("/").at(-1) ?? path, path, sizeBytes };
    });
    return {
      status: "ready",
      projectId: project.id,
      root: `/workspace/projects/${project.id}`,
      files,
      totalBytes,
      errorCode: null
    };
  };

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
      run: async (command, _terminalId, onOutput) => {
        if (command === "stress-log") onOutput?.({ stream: "stdout", data: "x".repeat(70 * 1_024) });
        return { exitCode: 0 };
      },
      input: () => true,
      resize() {},
      signal: () => true,
      close: () => true,
      activeCount: () => 0,
      processes: () => []
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
        emit({ ...state, workflowPhase: "hmr_connected", hmrState: "connected", previewUrl: "/__internal-preview/" });
        return copyState();
      },
      stopPreview: () => true,
      restart: async () => copyState(),
      syncDeclaredPackages: async () => ({ added: [] }),
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
    ports: [],
    processes: [],
    diagnostics: [],
    localDraftAccess: "none",
    terminalProcessCount: 0,
    serverLogs: []
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
