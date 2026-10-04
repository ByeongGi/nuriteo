import {
  BrowserRuntimeSupervisor,
  HostProcessTable,
  redactRuntimeLog,
  type BrowserRuntimeSupervisorOptions,
  type HostProcessTableOptions
} from "@nuriteo/browser-host";
import {
  createPreviewWorkflowController,
  type PreviewWorkflowController,
  type PreviewWorkflowControllerOptions,
  type PreviewWorkflowEvent,
  type PreviewWorkflowPhase,
  type PreviewWorkflowSnapshot
} from "@nuriteo/preview-service";

const MAX_DIAGNOSTICS = 20;
const MAX_DIAGNOSTIC_LENGTH = 512;
const DEFAULT_CLEANUP_TIMEOUT_MS = 2_000;
const CONTENT_ADDRESSED_ASSET = /^\/runtime\/[0-9a-f]{64}\//u;

export type RuntimeLifecycle =
  | "idle"
  | "mounting"
  | "ready"
  | "disposing"
  | "disposed"
  | "failed";

export interface RuntimeDiagnostic {
  code: string;
  severity: "info" | "warning" | "error";
  message: string;
}

export interface RuntimeMountInput {
  project: {
    id: string;
    localDraftKey: string;
    displayName: string;
  };
  assets: {
    systemWorkerUrl: string;
    processWorkerUrl: string;
    systemWasmUrl: string;
    previewServiceWorkerUrl: string;
  };
  policy?: {
    bootTimeoutMs?: number;
    relayTimeoutMs?: number;
    memoryLimitBytes?: number;
  };
  onDiagnostic?: (diagnostic: RuntimeDiagnostic) => void;
}

export interface RuntimeViewState {
  generation: number;
  lifecycle: RuntimeLifecycle;
  projectId: string | null;
  workflowPhase: PreviewWorkflowPhase | "idle";
  previewUrl: string | null;
  diagnostics: readonly RuntimeDiagnostic[];
  terminalCount: number;
}

export interface RuntimeTerminalPort {
  run(command: string, terminalId?: string, onOutput?: (chunk: { stream: "stdout" | "stderr"; data: string }) => void): Promise<unknown>;
  input(data: string, terminalId?: string): boolean;
  resize(cols: number, rows: number, terminalId?: string): void;
  signal(signal?: "SIGINT" | "SIGTERM" | "SIGKILL", terminalId?: string): boolean;
  close(terminalId: string): boolean;
  activeCount(): number;
}

export interface RuntimeWorkflowPort {
  stopPreview(port?: number): boolean;
  restart(): Promise<RuntimeViewState>;
  dispose(): Promise<void>;
}

export interface RuntimeAdapter {
  mount(input: RuntimeMountInput): Promise<RuntimeViewState>;
  subscribe(listener: (state: RuntimeViewState) => void): () => boolean;
  getState(): RuntimeViewState;
  readonly terminal: RuntimeTerminalPort;
  readonly workflow: RuntimeWorkflowPort;
  dispose(): Promise<void>;
}

interface SupervisorLike {
  boot(options?: { timeoutMs?: number }): Promise<unknown>;
  teardown(): Promise<void>;
}

interface ProcessTableLike {
  teardown(): void;
}

interface ControllerLike {
  on: PreviewWorkflowController["on"];
  getSnapshot: PreviewWorkflowController["getSnapshot"];
  runShellCommand(command: string, terminalId?: string, onOutput?: (chunk: { stream: "stdout" | "stderr"; data: string }) => void): Promise<unknown>;
  writeShellInput: PreviewWorkflowController["writeShellInput"];
  resizeShell: PreviewWorkflowController["resizeShell"];
  signalShell: PreviewWorkflowController["signalShell"];
  closeShell: PreviewWorkflowController["closeShell"];
  listShellProcesses(): readonly unknown[];
  restartDev: PreviewWorkflowController["restartDev"];
  stopPreviewPort: PreviewWorkflowController["stopPreviewPort"];
  dispose: PreviewWorkflowController["dispose"];
}

export interface RuntimeAdapterDependencies {
  origin?: () => string;
  createSupervisor?: (options: BrowserRuntimeSupervisorOptions) => SupervisorLike;
  createProcessTable?: (options: HostProcessTableOptions) => ProcessTableLike;
  createController?: (options: PreviewWorkflowControllerOptions) => ControllerLike;
  cleanupTimeoutMs?: number;
}

interface OwnedRuntime {
  generation: number;
  abortController: AbortController;
  supervisor: SupervisorLike;
  processTable: ProcessTableLike;
  controller: ControllerLike;
  unsubscribe: () => boolean;
  onDiagnostic?: (diagnostic: RuntimeDiagnostic) => void;
}

export function createRuntimeAdapter(dependencies: RuntimeAdapterDependencies = {}): RuntimeAdapter {
  const listeners = new Set<(state: RuntimeViewState) => void>();
  let state = createInitialState();
  let owned: OwnedRuntime | null = null;
  let disposePromise: Promise<void> | null = null;

  const terminal: RuntimeTerminalPort = {
    run(command, terminalId, onOutput) {
      return requireReady().controller.runShellCommand(command, terminalId, onOutput);
    },
    input(data, terminalId) {
      return requireReady().controller.writeShellInput(data, terminalId);
    },
    resize(cols, rows, terminalId) {
      requireReady().controller.resizeShell(cols, rows, terminalId);
    },
    signal(signal, terminalId) {
      return requireReady().controller.signalShell(signal, terminalId);
    },
    close(terminalId) {
      return requireReady().controller.closeShell(terminalId);
    },
    activeCount() {
      return owned?.controller.listShellProcesses().length ?? 0;
    }
  };

  const workflow: RuntimeWorkflowPort = {
    stopPreview(port) {
      return requireReady().controller.stopPreviewPort(port);
    },
    async restart() {
      const current = requireReady();
      const snapshot = await current.controller.restartDev();
      applySnapshot(current, snapshot);
      return publicState();
    },
    dispose
  };

  async function mount(input: RuntimeMountInput): Promise<RuntimeViewState> {
    if (!isMountable(state.lifecycle)) {
      throw new Error(`Runtime cannot mount while lifecycle is ${state.lifecycle}`);
    }

    const generation = state.generation + 1;
    state = {
      ...createInitialState(),
      generation,
      lifecycle: "mounting",
      projectId: validateProject(input.project).id
    };
    disposePromise = null;
    emit();

    let constructingProcessTable: ProcessTableLike | null = null;
    let constructingSupervisor: SupervisorLike | null = null;
    let constructingController: ControllerLike | null = null;

    try {
      const origin = dependencies.origin?.() ?? browserOrigin();
      const assets = validateAssets(input.assets, origin);
      const processTable = (dependencies.createProcessTable ?? defaultProcessTableFactory(assets.processWorkerUrl))({});
      constructingProcessTable = processTable;
      const supervisor = (dependencies.createSupervisor ?? ((options) => new BrowserRuntimeSupervisor(options)))({
        systemWorkerUrl: assets.systemWorkerUrl,
        processWorkerUrl: assets.processWorkerUrl,
        systemWasmUrl: assets.systemWasmUrl,
        ...(input.policy?.memoryLimitBytes === undefined ? {} : { memoryLimitBytes: input.policy.memoryLimitBytes }),
        ...(input.policy?.bootTimeoutMs === undefined ? {} : { timeoutMs: input.policy.bootTimeoutMs })
      });
      constructingSupervisor = supervisor;
      const controller = (dependencies.createController ?? ((options) => createPreviewWorkflowController(options)))({
        terminalProcessTable: processTable as HostProcessTable,
        previewServiceWorkerUrl: assets.previewServiceWorkerUrl,
        ...(input.policy?.relayTimeoutMs === undefined ? {} : { relayTimeoutMs: input.policy.relayTimeoutMs })
      });
      constructingController = controller;
      const abortController = new AbortController();
      const current: OwnedRuntime = {
        generation,
        abortController,
        supervisor,
        processTable,
        controller,
        unsubscribe: () => false,
        ...(input.onDiagnostic ? { onDiagnostic: input.onDiagnostic } : {})
      };
      current.unsubscribe = controller.on((event) => receiveEvent(current, event));
      owned = current;
      constructingProcessTable = null;
      constructingSupervisor = null;
      constructingController = null;

      await raceAbort(supervisor.boot(
        input.policy?.bootTimeoutMs === undefined ? {} : { timeoutMs: input.policy.bootTimeoutMs }
      ), abortController.signal);
      if (!isCurrent(current) || abortController.signal.aborted) return publicState();
      state = { ...state, lifecycle: "ready" };
      applySnapshot(current, controller.getSnapshot());
      return publicState();
    } catch (error) {
      if (state.lifecycle === "disposing" || state.lifecycle === "disposed") {
        await Promise.resolve();
        await disposePromise;
        return publicState();
      }
      const diagnostic = fixedDiagnostic("RUNTIME_BOOT_FAILED", "Runtime could not start. Dispose and retry this Project.");
      appendDiagnostic(diagnostic, input.onDiagnostic);
      state = { ...state, lifecycle: "failed" };
      emit();
      if (owned) await cleanupOwned(owned, false);
      else await rollbackConstruction(constructingController, constructingProcessTable, constructingSupervisor);
      throw new RuntimeAdapterError(diagnostic.code, diagnostic.message, error);
    }
  }

  function subscribe(listener: (state: RuntimeViewState) => void): () => boolean {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function getState(): RuntimeViewState {
    return publicState();
  }

  function dispose(): Promise<void> {
    if (disposePromise) return disposePromise;
    if (!owned) {
      state = { ...state, lifecycle: "disposed", projectId: null, previewUrl: null, terminalCount: 0 };
      emit();
      listeners.clear();
      disposePromise = Promise.resolve();
      return disposePromise;
    }

    const current = owned;
    state = { ...state, lifecycle: "disposing" };
    emit();
    disposePromise = cleanupOwned(current, true);
    return disposePromise;
  }

  async function cleanupOwned(current: OwnedRuntime, publishDisposed: boolean): Promise<void> {
    current.abortController.abort();
    current.unsubscribe();
    const cleanup = async () => {
      safely(() => current.controller.dispose());
      safely(() => current.processTable.teardown());
      await safelyAsync(() => current.supervisor.teardown());
    };
    try {
      await withTimeout(cleanup(), dependencies.cleanupTimeoutMs ?? DEFAULT_CLEANUP_TIMEOUT_MS);
    } catch {
      appendDiagnostic(fixedDiagnostic("RUNTIME_CLEANUP_TIMEOUT", "Runtime cleanup exceeded its bounded deadline."), current.onDiagnostic);
    }
    if (owned === current) owned = null;
    if (publishDisposed) {
      state = {
        ...state,
        lifecycle: "disposed",
        projectId: null,
        workflowPhase: "idle",
        previewUrl: null,
        terminalCount: 0
      };
      emit();
      listeners.clear();
    }
  }

  async function rollbackConstruction(
    controller: ControllerLike | null,
    processTable: ProcessTableLike | null,
    supervisor: SupervisorLike | null
  ): Promise<void> {
    const rollback = async () => {
      if (controller) safely(() => controller.dispose());
      if (supervisor) await safelyAsync(() => supervisor.teardown());
      if (processTable) safely(() => processTable.teardown());
    };
    try {
      await withTimeout(rollback(), dependencies.cleanupTimeoutMs ?? DEFAULT_CLEANUP_TIMEOUT_MS);
    } catch {
      appendDiagnostic(fixedDiagnostic("RUNTIME_CLEANUP_TIMEOUT", "Runtime construction rollback exceeded its bounded deadline."));
    }
  }

  function receiveEvent(current: OwnedRuntime, event: PreviewWorkflowEvent): void {
    if (!isCurrent(current) || current.abortController.signal.aborted) return;
    applySnapshot(current, event.snapshot);
  }

  function applySnapshot(current: OwnedRuntime, snapshot: PreviewWorkflowSnapshot): void {
    if (!isCurrent(current) || current.abortController.signal.aborted) return;
    const diagnostics = snapshot.diagnostics.map(normalizeDiagnostic).slice(-MAX_DIAGNOSTICS);
    state = {
      ...state,
      workflowPhase: snapshot.phase,
      previewUrl: snapshot.previewUrl,
      diagnostics,
      terminalCount: current.controller.listShellProcesses().length
    };
    emit();
  }

  function appendDiagnostic(diagnostic: RuntimeDiagnostic, callback?: (diagnostic: RuntimeDiagnostic) => void): void {
    state = { ...state, diagnostics: [...state.diagnostics, diagnostic].slice(-MAX_DIAGNOSTICS) };
    try { callback?.(diagnostic); } catch { /* consumer diagnostics must not break cleanup */ }
  }

  function isCurrent(current: OwnedRuntime): boolean {
    return owned === current && state.generation === current.generation;
  }

  function requireReady(): OwnedRuntime {
    if (!owned || state.lifecycle !== "ready") {
      throw new RuntimeAdapterError("RUNTIME_NOT_READY", "Runtime command rejected because the Project is not ready.");
    }
    return owned;
  }

  function emit(): void {
    const snapshot = publicState();
    for (const listener of listeners) {
      try { listener(snapshot); } catch { /* one consumer cannot block runtime ownership */ }
    }
  }

  function publicState(): RuntimeViewState {
    return { ...state, diagnostics: state.diagnostics.map((diagnostic) => ({ ...diagnostic })) };
  }

  return { mount, subscribe, getState, terminal, workflow, dispose };
}

export class RuntimeAdapterError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: unknown) {
    super(message, options === undefined ? undefined : { cause: options });
    this.name = "RuntimeAdapterError";
    this.code = code;
  }
}

function createInitialState(): RuntimeViewState {
  return {
    generation: 0,
    lifecycle: "idle",
    projectId: null,
    workflowPhase: "idle",
    previewUrl: null,
    diagnostics: [],
    terminalCount: 0
  };
}

function isMountable(lifecycle: RuntimeLifecycle): boolean {
  return lifecycle === "idle" || lifecycle === "disposed" || lifecycle === "failed";
}

function browserOrigin(): string {
  if (typeof globalThis.location?.origin !== "string") {
    throw new RuntimeAdapterError("RUNTIME_BROWSER_REQUIRED", "Runtime mount requires a browser origin.");
  }
  return globalThis.location.origin;
}

function validateProject(project: RuntimeMountInput["project"]): RuntimeMountInput["project"] {
  if (!project.id.trim() || !project.localDraftKey.trim() || !project.displayName.trim()) {
    throw new RuntimeAdapterError("RUNTIME_PROJECT_INVALID", "Runtime Project context is incomplete.");
  }
  return project;
}

function validateAssets(assets: RuntimeMountInput["assets"], origin: string): RuntimeMountInput["assets"] {
  for (const [name, value] of Object.entries(assets)) {
    const url = new URL(value, origin);
    if (url.origin !== origin || url.username || url.password || url.hash || url.search || !CONTENT_ADDRESSED_ASSET.test(url.pathname)) {
      throw new RuntimeAdapterError(
        "RUNTIME_ASSET_INVALID",
        `${name} must be a same-origin content-addressed /runtime/<sha256>/ asset URL.`
      );
    }
  }
  return assets;
}

function defaultProcessTableFactory(processWorkerUrl: string): (options: HostProcessTableOptions) => HostProcessTable {
  return (options) => new HostProcessTable({
    ...options,
    workerFactory: (record) => new Worker(processWorkerUrl, { type: "module", name: `nuriteo-process-${record.pid}` })
  });
}

function normalizeDiagnostic(input: PreviewWorkflowSnapshot["diagnostics"][number]): RuntimeDiagnostic {
  const level = input.level?.toLowerCase();
  return {
    code: boundedText(input.code ?? "RUNTIME_DIAGNOSTIC", 64),
    severity: level === "error" ? "error" : level === "warning" || level === "warn" ? "warning" : "info",
    message: boundedText(redactRuntimeLog(input.message), MAX_DIAGNOSTIC_LENGTH)
  };
}

function fixedDiagnostic(code: string, message: string): RuntimeDiagnostic {
  return { code, severity: "error", message };
}

function boundedText(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, Math.max(0, limit - 1))}…`;
}

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new RuntimeAdapterError("RUNTIME_MOUNT_CANCELLED", "Runtime mount was cancelled."));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new RuntimeAdapterError("RUNTIME_MOUNT_CANCELLED", "Runtime mount was cancelled."));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener("abort", onAbort); resolve(value); },
      (error) => { signal.removeEventListener("abort", onAbort); reject(error); }
    );
  });
}

function safely(action: () => void): void {
  try { action(); } catch { /* cleanup continues through every owned resource */ }
}

async function safelyAsync(action: () => Promise<void>): Promise<void> {
  try { await action(); } catch { /* cleanup continues through every owned resource */ }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("bounded cleanup timeout")), timeoutMs);
    promise.then(
      (value) => { clearTimeout(timeout); resolve(value); },
      (error) => { clearTimeout(timeout); reject(error); }
    );
  });
}
