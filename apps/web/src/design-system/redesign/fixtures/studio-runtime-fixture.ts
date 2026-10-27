import type {
  RuntimeAdapter,
  RuntimeDiagnostic,
  RuntimeRecoveryActionKind,
  RuntimeViewState,
  RuntimeWorkspaceState
} from "#src/runtime/runtime-adapter.ts";

interface StudioRuntimeFixtureOptions {
  readonly fileCount?: number;
  readonly mode?: "ready" | "conflict" | "failure";
  readonly projectId: string;
}

type RuntimeFeature = typeof import("#src/runtime/runtime-adapter.ts");

export function createStudioRuntimeFeatureLoader(options: StudioRuntimeFixtureOptions) {
  return async (): Promise<RuntimeFeature> => ({
    createRuntimeAdapter: () => createStudioRuntimeAdapter(options)
  }) as RuntimeFeature;
}

function createStudioRuntimeAdapter({ fileCount = 4, mode = "ready", projectId }: StudioRuntimeFixtureOptions): RuntimeAdapter {
  const listeners = new Set<(state: RuntimeViewState) => void>();
  const workspaceText = createWorkspaceFiles(fileCount);
  let state = runtimeState(projectId, "idle", "none", []);

  function emit(next: RuntimeViewState) {
    state = next;
    for (const listener of listeners) listener(copyRuntimeState(state));
  }

  function workspaceState(): RuntimeWorkspaceState {
    let totalBytes = 0;
    const files = Array.from(workspaceText, ([path, content]) => {
      const sizeBytes = new TextEncoder().encode(content).byteLength;
      totalBytes += sizeBytes;
      return {
        kind: "text" as const,
        name: path.split("/").at(-1) ?? path,
        path,
        sizeBytes
      };
    });
    return {
      directories: [],
      errorCode: null,
      files,
      projectId,
      root: `/workspace/projects/${projectId}`,
      status: "ready",
      totalBytes
    };
  }

  const adapter: RuntimeAdapter = {
    async mount() {
      emit(runtimeState(
        projectId,
        "ready",
        mode === "conflict" ? "conflict" : "writer",
        mode === "conflict" ? [writerConflictDiagnostic()] : mode === "failure" ? [previewFailureDiagnostic()] : []
      ));
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    getState: () => copyRuntimeState(state),
    terminal: {
      async run(command, _terminalId, onOutput) {
        onOutput?.({ stream: "stdout", data: `$ ${command}\nready in 428ms\n` });
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
        } else {
          emit({ ...state, diagnostics: [], workflowPhase: "idle" });
        }
        return copyRuntimeState(state);
      }
    },
    workflow: {
      async start() {
        emit({ ...state, diagnostics: [], hmrState: "connected", previewUrl: "/__fixture-preview/", workflowPhase: "hmr_connected" });
        return copyRuntimeState(state);
      },
      stopPreview: () => true,
      restart: async () => copyRuntimeState(state),
      syncDeclaredPackages: async () => ({ added: [] }),
      cancel() {},
      dispose: async () => undefined
    },
    workspace: {
      materializeTemplate: async () => workspaceState(),
      materializeBundle: async () => workspaceState(),
      exportBundleFiles: () => [],
      snapshotBundleFiles: () => ({ files: [], revision: 0 }),
      currentRevision: () => 0,
      getState: workspaceState,
      readText(path) {
        const content = workspaceText.get(path);
        if (content === undefined) throw new Error("Fixture file does not exist.");
        return content;
      },
      createText(path, content = "") {
        if (workspaceText.has(path)) throw new Error("Fixture file already exists.");
        workspaceText.set(path, content);
        return copyRuntimeState(state);
      },
      createDirectory() {
        return copyRuntimeState(state);
      },
      movePath(from, to) {
        const content = workspaceText.get(from);
        if (content !== undefined) {
          workspaceText.delete(from);
          workspaceText.set(to, content);
        }
        return copyRuntimeState(state);
      },
      deletePath(path) {
        for (const candidate of [...workspaceText.keys()]) {
          if (candidate === path || candidate.startsWith(`${path}/`)) workspaceText.delete(candidate);
        }
        return copyRuntimeState(state);
      },
      renameText(from, to) {
        const content = workspaceText.get(from);
        if (content === undefined || workspaceText.has(to)) throw new Error("Fixture file cannot be renamed.");
        workspaceText.delete(from);
        workspaceText.set(to, content);
        return copyRuntimeState(state);
      },
      deleteText(path) {
        if (!workspaceText.delete(path)) throw new Error("Fixture file does not exist.");
        return copyRuntimeState(state);
      },
      writeText(path, content) {
        workspaceText.set(path, content);
        return copyRuntimeState(state);
      }
    },
    async dispose() {
      emit(runtimeState(projectId, "idle", "none", []));
    }
  };

  return adapter;
}

function createWorkspaceFiles(fileCount: number): Map<string, string> {
  const files = new Map<string, string>([
    ["src/App.tsx", "export default function App() {\n  return <main>Hello, Nuriteo</main>;\n}\n"],
    ["src/main.tsx", "import App from '#src/design-system/redesign/fixtures/App';\n"],
    ["src/styles.css", ":root { font-family: Pretendard, sans-serif; }\n"],
    ["package.json", '{"scripts":{"dev":"vite"}}\n']
  ]);
  for (let index = files.size; index < fileCount; index += 1) {
    const suffix = String(index + 1).padStart(4, "0");
    files.set(`src/generated/module-${suffix}.ts`, `export const module${suffix} = ${index};\n`);
  }
  return files;
}

function runtimeState(
  projectId: string,
  lifecycle: RuntimeViewState["lifecycle"],
  localDraftAccess: RuntimeViewState["localDraftAccess"],
  diagnostics: readonly RuntimeDiagnostic[]
): RuntimeViewState {
  return {
    diagnostics,
    generation: lifecycle === "ready" ? 1 : 0,
    hmrState: "idle",
    lifecycle,
    localDraftAccess,
    ports: [],
    previewUrl: null,
    processes: [],
    projectId,
    terminalProcessCount: 0,
    serverLogs: [],
    workflowPhase: "idle"
  };
}

function copyRuntimeState(state: RuntimeViewState): RuntimeViewState {
  return {
    ...state,
    diagnostics: state.diagnostics.map((diagnostic) => ({
      ...diagnostic,
      actions: [...diagnostic.actions]
    })),
    ports: state.ports.map((port) => ({ ...port })),
    processes: state.processes.map((process) => ({ ...process, argv: [...process.argv] }))
  };
}

function writerConflictDiagnostic(): RuntimeDiagnostic {
  return {
    actions: [{ kind: "resolve-writer-conflict", label: "편집 권한 가져오기" }],
    code: "ELEASEHELD",
    message: "다른 탭에서 이 프로젝트를 편집하고 있습니다.",
    severity: "error"
  };
}

function previewFailureDiagnostic(): RuntimeDiagnostic {
  return {
    actions: [{ kind: "retry", label: "미리보기 다시 시도" }],
    code: "RUNTIME_PREVIEW_FAILED",
    message: "미리보기 프로세스가 준비되기 전에 종료되었습니다.",
    severity: "error"
  };
}
