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
    systemWorkerUrl: URL;
    processWorkerUrl: URL;
    systemWasmUrl: URL;
    previewServiceWorkerUrl: URL;
  };
  policy: {
    bootTimeoutMs: number;
    relayTimeoutMs: number;
    memoryLimitBytes: number;
  };
  reportDiagnostic(diagnostic: RuntimeDiagnostic): void;
}

export interface RuntimeViewState {
  generation: number;
  lifecycle: RuntimeLifecycle;
  projectId: string | null;
  workflowPhase: PreviewWorkflowPhase | "idle";
  previewUrl: string | null;
  diagnostics: readonly RuntimeDiagnostic[];
  terminalProcessCount: number;
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
  mount(input: RuntimeMountInput): Promise<void>;
  subscribe(listener: (state: RuntimeViewState) => void): () => void;
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
  reportDiagnostic: (diagnostic: RuntimeDiagnostic) => void;
}

export function createRuntimeAdapter(dependencies: RuntimeAdapterDependencies = {}): RuntimeAdapter {
  const listeners = new Set<(state: RuntimeViewState) => void>();
  let state = createInitialState();
  let owned: OwnedRuntime | null = null;
  let disposePromise: Promise<void> | null = null;
  let cleanupBlocked = false;

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

  async function mount(input: RuntimeMountInput): Promise<void> {
    if (cleanupBlocked || owned || !isMountable(state.lifecycle)) {
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
      validatePolicy(input.policy);
      const processTable = (dependencies.createProcessTable ?? defaultProcessTableFactory(
        assets.processWorkerUrl,
        assets.systemWasmUrl
      ))({});
      constructingProcessTable = processTable;
      const supervisor = (dependencies.createSupervisor ?? ((options) => new BrowserRuntimeSupervisor(options)))({
        systemWorkerUrl: assets.systemWorkerUrl,
        processWorkerUrl: assets.processWorkerUrl,
        systemWasmUrl: assets.systemWasmUrl,
        memoryLimitBytes: input.policy.memoryLimitBytes,
        timeoutMs: input.policy.bootTimeoutMs
      });
      constructingSupervisor = supervisor;
      const controller = (dependencies.createController ?? ((options) => createPreviewWorkflowController(options)))({
        terminalProcessTable: processTable as HostProcessTable,
        previewServiceWorkerUrl: assets.previewServiceWorkerUrl,
        relayTimeoutMs: input.policy.relayTimeoutMs
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
        reportDiagnostic: input.reportDiagnostic
      };
      current.unsubscribe = controller.on((event) => receiveEvent(current, event));
      owned = current;
      constructingProcessTable = null;
      constructingSupervisor = null;
      constructingController = null;

      await raceAbort(supervisor.boot({ timeoutMs: input.policy.bootTimeoutMs }), abortController.signal);
      if (!isCurrent(current) || abortController.signal.aborted) return;
      state = { ...state, lifecycle: "ready" };
      applySnapshot(current, controller.getSnapshot());
    } catch (error) {
      if (state.lifecycle === "disposing" || state.lifecycle === "disposed") {
        await Promise.resolve();
        await disposePromise;
        return;
      }
      const diagnostic = fixedDiagnostic("RUNTIME_BOOT_FAILED", "Runtime could not start. Dispose and retry this Project.");
      appendDiagnostic(diagnostic, input.reportDiagnostic);
      state = { ...state, lifecycle: "failed" };
      emit();
      if (owned) await cleanupOwned(owned, false);
      else cleanupBlocked = !(await rollbackConstruction(
        constructingController,
        constructingProcessTable,
        constructingSupervisor
      ));
      throw new RuntimeAdapterError(diagnostic.code, diagnostic.message);
    }
  }

  function subscribe(listener: (state: RuntimeViewState) => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }

  function getState(): RuntimeViewState {
    return publicState();
  }

  function dispose(): Promise<void> {
    if (disposePromise) return disposePromise;
    if (!owned) {
      if (cleanupBlocked) {
        state = { ...state, lifecycle: "failed" };
        emit();
        return Promise.resolve();
      }
      state = { ...state, lifecycle: "disposed", projectId: null, previewUrl: null, terminalProcessCount: 0 };
      emit();
      listeners.clear();
      disposePromise = Promise.resolve();
      return disposePromise;
    }

    const current = owned;
    state = { ...state, lifecycle: "disposing" };
    emit();
    const pending = cleanupOwned(current, true).then((cleaned) => {
      if (!cleaned) disposePromise = null;
    });
    disposePromise = pending;
    return disposePromise;
  }

  async function cleanupOwned(current: OwnedRuntime, publishDisposed: boolean): Promise<boolean> {
    current.abortController.abort();
    const failures: string[] = [];
    try { current.unsubscribe(); } catch { failures.push("subscription"); }
    try { current.controller.dispose(); } catch { failures.push("controller"); }
    try { current.processTable.teardown(); } catch { failures.push("process-table"); }
    try {
      await withTimeout(current.supervisor.teardown(), dependencies.cleanupTimeoutMs ?? DEFAULT_CLEANUP_TIMEOUT_MS);
    } catch {
      failures.push("supervisor");
    }
    if (failures.length > 0) {
      cleanupBlocked = true;
      appendDiagnostic(fixedDiagnostic(
        "RUNTIME_CLEANUP_FAILED",
        `Runtime cleanup did not release: ${failures.join(", ")}. Retry disposal before mounting another Project.`
      ), current.reportDiagnostic);
      state = { ...state, lifecycle: "failed" };
      emit();
      return false;
    }
    cleanupBlocked = false;
    if (owned === current) owned = null;
    if (publishDisposed) {
      state = {
        ...state,
        lifecycle: "disposed",
        projectId: null,
        workflowPhase: "idle",
        previewUrl: null,
        terminalProcessCount: 0
      };
      emit();
      listeners.clear();
    }
    return true;
  }

  async function rollbackConstruction(
    controller: ControllerLike | null,
    processTable: ProcessTableLike | null,
    supervisor: SupervisorLike | null
  ): Promise<boolean> {
    const failures: string[] = [];
    if (controller) try { controller.dispose(); } catch { failures.push("controller"); }
    if (supervisor) try {
      await withTimeout(supervisor.teardown(), dependencies.cleanupTimeoutMs ?? DEFAULT_CLEANUP_TIMEOUT_MS);
    } catch { failures.push("supervisor"); }
    if (processTable) try { processTable.teardown(); } catch { failures.push("process-table"); }
    if (failures.length === 0) return true;
    appendDiagnostic(fixedDiagnostic(
      "RUNTIME_CLEANUP_FAILED",
      `Runtime construction rollback did not release: ${failures.join(", ")}. Reload before mounting another Project.`
    ));
    state = { ...state, lifecycle: "failed" };
    emit();
    return false;
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
      terminalProcessCount: current.controller.listShellProcesses().length
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

  constructor(code: string, message: string) {
    super(message);
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
    terminalProcessCount: 0
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
    const url = value;
    if (url.origin !== new URL(origin).origin || url.username || url.password || url.hash || url.search || !CONTENT_ADDRESSED_ASSET.test(url.pathname)) {
      throw new RuntimeAdapterError(
        "RUNTIME_ASSET_INVALID",
        `${name} must be a same-origin content-addressed /runtime/<sha256>/ asset URL.`
      );
    }
  }
  return assets;
}

function validatePolicy(policy: RuntimeMountInput["policy"]): void {
  for (const [name, value] of Object.entries(policy)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new RuntimeAdapterError("RUNTIME_POLICY_INVALID", `${name} must be a positive safe integer.`);
    }
  }
}

function defaultProcessTableFactory(
  processWorkerUrl: URL,
  systemWasmUrl: URL
): (options: HostProcessTableOptions) => HostProcessTable {
  return (options) => new HostProcessTable({
    ...options,
    workerInitialization: { systemWasmUrl },
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

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("bounded cleanup timeout")), timeoutMs);
    promise.then(
      (value) => { clearTimeout(timeout); resolve(value); },
      (error) => { clearTimeout(timeout); reject(error); }
    );
  });
}
