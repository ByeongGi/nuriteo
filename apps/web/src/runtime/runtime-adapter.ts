import {
  HostProcessTable,
  type HostProcessTableOptions
} from "@nuriteo/browser-host/process";
import { redactRuntimeLog } from "@nuriteo/browser-host/redaction";
import {
  BrowserRuntimeSupervisor,
  type BrowserRuntimeSupervisorOptions
} from "@nuriteo/browser-host/supervisor";
import {
  createPreviewWorkflowController,
  type PreviewWorkflowController,
  type PreviewWorkflowControllerOptions,
  type PreviewWorkflowEvent,
  type PreviewWorkflowPhase,
  type PreviewWorkflowSnapshot
} from "@nuriteo/workspace-runtime";

import {
  createLocalDraftWriterLease,
  type LocalDraftWriterLease,
  type LocalDraftWriterLeaseOptions
} from "#src/runtime/local-draft-writer.ts";

import { RuntimeAdapterError } from "#src/runtime/runtime-adapter-error.ts";
import {
  createRuntimeWorkspace,
  diffRuntimeFiles,
  projectRoot,
  snapshotRuntimeFiles
} from "#src/runtime/runtime-workspace.ts";

export { RuntimeAdapterError };

const MAX_DIAGNOSTICS = 20;
const MAX_DIAGNOSTIC_LENGTH = 512;
const DEFAULT_CLEANUP_TIMEOUT_MS = 2_000;
const CONTENT_ADDRESSED_ASSET = /^\/runtime\/[0-9a-f]{64}\//u;
const UUID_V7 = "[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const UUID_V7_VALUE = new RegExp(`^${UUID_V7}$`, "u");
const PROJECT_CONTEXT_KEYS = ["displayName", "id", "storageScopeId", "workspaceScopeId"] as const;

export type RuntimeLifecycle =
  | "idle"
  | "mounting"
  | "ready"
  | "disposing"
  | "disposed"
  | "failed";

export interface RuntimePortInfo {
  readonly label: string;
  readonly port: number;
  readonly status: "running" | "stopped";
  readonly url: string;
}

export interface RuntimeProcessInfo {
  readonly argv: readonly string[];
  readonly command: string;
  readonly cwd: string;
  readonly generation?: number;
  readonly pid: number;
  readonly status: string;
  readonly terminalId: string;
  readonly terminalSize?: { readonly cols: number; readonly rows: number };
}

export interface RuntimeDiagnostic {
  code: string;
  severity: "info" | "warning" | "error";
  message: string;
  actions: readonly RuntimeRecoveryAction[];
}

export type RuntimeRecoveryActionKind =
  | "clear-cache"
  | "reset-runtime"
  | "resolve-writer-conflict"
  | "restart-dev-server"
  | "retry";

export interface RuntimeRecoveryAction {
  kind: RuntimeRecoveryActionKind;
  label: string;
}

export interface RuntimeMountInput {
  project: {
    id: string;
    storageScopeId: string;
    workspaceScopeId: string;
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
  hmrState: PreviewWorkflowSnapshot["hmrState"];
  previewUrl: string | null;
  ports: readonly RuntimePortInfo[];
  processes: readonly RuntimeProcessInfo[];
  diagnostics: readonly RuntimeDiagnostic[];
  localDraftAccess: "none" | "writer" | "conflict" | "lost";
  terminalProcessCount: number;
  serverLogs: readonly string[];
}

export interface RuntimeTerminalPort {
  run(command: string, terminalId?: string, onOutput?: (chunk: { stream: "stdout" | "stderr"; data: string }) => void): Promise<RuntimeTerminalRunResult>;
  input(data: string, terminalId?: string): boolean;
  resize(cols: number, rows: number, terminalId?: string): void;
  signal(signal?: "SIGINT" | "SIGTERM" | "SIGKILL", terminalId?: string): boolean;
  close(terminalId: string): boolean;
  activeCount(): number;
  processes(): readonly RuntimeProcessInfo[];
}

export interface RuntimeTerminalFileChange {
  readonly kind: "content" | "create" | "delete" | "rename";
  readonly path: string;
  readonly previousPath?: string;
}

export interface RuntimeTerminalRunResult {
  readonly changedFiles?: readonly RuntimeTerminalFileChange[];
  readonly exitCode?: number;
  readonly stderr?: string;
  readonly stdout?: string;
  readonly [key: string]: unknown;
}

export interface RuntimeWorkflowPort {
  start(): Promise<RuntimeViewState>;
  stopPreview(port?: number): boolean;
  restart(): Promise<RuntimeViewState>;
  syncDeclaredPackages(): Promise<{ added: string[] }>;
  cancel(): void;
  dispose(): Promise<void>;
}

export interface RuntimeRecoveryPort {
  run(kind: RuntimeRecoveryActionKind): Promise<RuntimeViewState>;
}

export type RuntimeStarterTemplate = "vite-react" | "next-app";

export interface RuntimeWorkspaceFile {
  path: string;
  name: string;
  kind: "text" | "binary";
  sizeBytes: number;
}

export interface RuntimeWorkspaceState {
  status: "empty" | "materializing" | "ready" | "failed";
  projectId: string | null;
  root: string | null;
  files: readonly RuntimeWorkspaceFile[];
  directories: readonly string[];
  totalBytes: number;
  errorCode: string | null;
}

export interface RuntimeBundleFile {
  readonly path: string;
  readonly kind: "text" | "binary";
  readonly bytes: Uint8Array;
}

export interface RuntimeWorkspaceSnapshot {
  readonly revision: number;
  readonly files: readonly RuntimeBundleFile[];
}

export interface RuntimeWorkspacePort {
  materializeTemplate(template: RuntimeStarterTemplate): Promise<RuntimeWorkspaceState>;
  materializeBundle(files: readonly RuntimeBundleFile[]): Promise<RuntimeWorkspaceState>;
  exportBundleFiles(): readonly RuntimeBundleFile[];
  snapshotBundleFiles(): RuntimeWorkspaceSnapshot;
  currentRevision(): number;
  getState(): RuntimeWorkspaceState;
  readText(path: string): string;
  createText(path: string, content?: string): RuntimeViewState;
  createDirectory(path: string): RuntimeViewState;
  movePath(from: string, to: string): RuntimeViewState;
  renameText(from: string, to: string): RuntimeViewState;
  deleteText(path: string): RuntimeViewState;
  deletePath(path: string): RuntimeViewState;
  writeText(path: string, content: string): RuntimeViewState;
}

export interface RuntimeAdapter {
  mount(input: RuntimeMountInput): Promise<void>;
  subscribe(listener: (state: RuntimeViewState) => void): () => void;
  getState(): RuntimeViewState;
  readonly terminal: RuntimeTerminalPort;
  readonly recovery: RuntimeRecoveryPort;
  readonly workflow: RuntimeWorkflowPort;
  readonly workspace: RuntimeWorkspacePort;
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
  listShellProcesses: PreviewWorkflowController["listShellProcesses"];
  restartDev: PreviewWorkflowController["restartDev"];
  runPreview: PreviewWorkflowController["runPreview"];
  createTextFile: PreviewWorkflowController["createTextFile"];
  createDirectory: PreviewWorkflowController["createDirectory"];
  movePath: PreviewWorkflowController["movePath"];
  renameFile: PreviewWorkflowController["renameFile"];
  cancelPreview: PreviewWorkflowController["cancelPreview"];
  deleteFile: PreviewWorkflowController["deleteFile"];
  deletePath: PreviewWorkflowController["deletePath"];
  saveTextFile: PreviewWorkflowController["saveTextFile"];
  syncDeclaredPackages: PreviewWorkflowController["syncDeclaredPackages"];
  runRecoveryAction: PreviewWorkflowController["runRecoveryAction"];
  stopPreviewPort: PreviewWorkflowController["stopPreviewPort"];
  loadTemplate: PreviewWorkflowController["loadTemplate"];
  importProjectFiles: PreviewWorkflowController["importProjectFiles"];
  exportProjectFiles: PreviewWorkflowController["exportProjectFiles"];
  exportTreeJson: PreviewWorkflowController["exportTreeJson"];
  dispose: PreviewWorkflowController["dispose"];
}

export interface RuntimeAdapterDependencies {
  origin?: () => string;
  createSupervisor?: (options: BrowserRuntimeSupervisorOptions) => SupervisorLike;
  createProcessTable?: (options: HostProcessTableOptions) => ProcessTableLike;
  createController?: (options: PreviewWorkflowControllerOptions) => ControllerLike;
  createWriterLease?: (options: LocalDraftWriterLeaseOptions) => LocalDraftWriterLease;
  cleanupTimeoutMs?: number;
}

interface OwnedRuntime {
  generation: number;
  projectId: string;
  displayName: string;
  abortController: AbortController;
  supervisor: SupervisorLike;
  processTable: ProcessTableLike;
  controller: ControllerLike;
  writerLease: LocalDraftWriterLease | null;
  unsubscribe: () => boolean;
  reportDiagnostic: (diagnostic: RuntimeDiagnostic) => void;
}

export function createRuntimeAdapter(dependencies: RuntimeAdapterDependencies = {}): RuntimeAdapter {
  const listeners = new Set<(state: RuntimeViewState) => void>();
  let state = createInitialState();
  let owned: OwnedRuntime | null = null;
  let disposePromise: Promise<void> | null = null;
  let cleanupBlocked = false;
  let adapterDiagnostics: RuntimeDiagnostic[] = [];
  let workflowDiagnostics: RuntimeDiagnostic[] = [];
  const workspaceBundle = createRuntimeWorkspace({
    requireReady,
    isCurrent,
    projectId: () => state.projectId,
    localDraftAccess: () => state.localDraftAccess,
    applySnapshot,
    publicState
  });
  const workspace = workspaceBundle.port;

  const terminal: RuntimeTerminalPort = {
    async run(command, terminalId, onOutput) {
      const current = requireReady();
      const before = snapshotRuntimeFiles(current.controller.exportProjectFiles());
      let result: unknown;
      let changedFiles: RuntimeTerminalFileChange[] = [];
      try {
        result = await current.controller.runShellCommand(command, terminalId, onOutput);
      } finally {
        changedFiles = diffRuntimeFiles(before, snapshotRuntimeFiles(current.controller.exportProjectFiles()));
        workspaceBundle.synchronize(current);
        if (changedFiles.length > 0) workspaceBundle.markMutation();
        applySnapshot(current, current.controller.getSnapshot());
      }
      if (typeof result === "object" && result !== null && !Array.isArray(result)) {
        return { ...result, changedFiles };
      }
      return { changedFiles, value: result };
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
    },
    processes() {
      return owned ? runtimeProcesses(owned.controller.listShellProcesses()) : [];
    }
  };

  const workflow: RuntimeWorkflowPort = {
    async start() {
      const current = requireReady();
      try {
        const snapshot = await raceAbort(current.controller.runPreview(), current.abortController.signal);
        removeAdapterDiagnostics("RUNTIME_PREVIEW_FAILED", "RUNTIME_RECOVERY_FAILED");
        applySnapshot(current, snapshot);
        return publicState();
      } catch (error) {
        const cause = error instanceof Error ? error.message.trim() : String(error).trim();
        if (cause === "Preview controller operation cancelled") {
          throw new RuntimeAdapterError("RUNTIME_PREVIEW_CANCELLED", cause);
        }
        const diagnostic = fixedDiagnostic(
          "RUNTIME_PREVIEW_FAILED",
          cause || "The install and Preview journey did not complete.",
          [{ kind: "retry", label: "Retry Preview" }]
        );
        appendDiagnostic(diagnostic, current.reportDiagnostic);
        throw new RuntimeAdapterError(diagnostic.code, diagnostic.message);
      }
    },
    stopPreview(port) {
      return requireReady().controller.stopPreviewPort(port);
    },
    async restart() {
      const current = requireReady();
      const snapshot = await current.controller.restartDev();
      applySnapshot(current, snapshot);
      return publicState();
    },
    async syncDeclaredPackages() {
      const current = requireReady();
      const result = await current.controller.syncDeclaredPackages();
      applySnapshot(current, current.controller.getSnapshot());
      return result;
    },
    cancel() {
      const current = requireReady();
      applySnapshot(current, current.controller.cancelPreview());
    },
    dispose
  };

  const recovery: RuntimeRecoveryPort = {
    async run(kind) {
      const current = requireReady();
      try {
        if (kind === "resolve-writer-conflict") {
          if (!current.writerLease) {
            throw new Error("Local Draft writer coordination is unavailable.");
          }
          await current.writerLease.takeOver();
          state = { ...state, localDraftAccess: "writer" };
          removeAdapterDiagnostics("ELEASEHELD", "ELEASELOST");
        }
        const result = current.controller.runRecoveryAction(kind);
        await raceAbort(Promise.resolve(result), current.abortController.signal);
        removeAdapterDiagnostics("RUNTIME_PREVIEW_FAILED", "RUNTIME_RECOVERY_FAILED");
        applySnapshot(current, current.controller.getSnapshot());
        return publicState();
      } catch (error) {
        const cause = error instanceof Error ? error.message.trim() : String(error).trim();
        const diagnostic = fixedDiagnostic(
          "RUNTIME_RECOVERY_FAILED",
          cause
            ? `${cause} Local Draft remains unchanged.`
            : "The recovery action did not complete. Your Local Draft remains unchanged.",
          [{ kind, label: recoveryLabel(kind) }]
        );
        appendDiagnostic(diagnostic, current.reportDiagnostic);
        throw new RuntimeAdapterError(diagnostic.code, diagnostic.message);
      }
    }
  };

  async function mount(input: RuntimeMountInput): Promise<void> {
    if (cleanupBlocked || owned || !isMountable(state.lifecycle)) {
      throw new Error(`Runtime cannot mount while lifecycle is ${state.lifecycle}`);
    }

    const project = validateProject(input.project);
    const generation = state.generation + 1;
    state = {
      ...createInitialState(),
      generation,
      lifecycle: "mounting",
      projectId: project.id
    };
    workspaceBundle.reset();
    adapterDiagnostics = [];
    workflowDiagnostics = [];
    disposePromise = null;
    emit();

    let constructingProcessTable: ProcessTableLike | null = null;
    let constructingSupervisor: SupervisorLike | null = null;
    let constructingController: ControllerLike | null = null;
    let constructingWriterLease: LocalDraftWriterLease | null = null;

    try {
      const origin = dependencies.origin?.() ?? browserOrigin();
      const assets = validateAssets(input.assets, origin);
      validatePolicy(input.policy);
      let writerLease: LocalDraftWriterLease | null = null;
      let hasWriter = false;
      let currentForLease: OwnedRuntime | null = null;
      try {
        writerLease = (dependencies.createWriterLease ?? createLocalDraftWriterLease)({
          namespace: localDraftNamespace(project),
          onLost() {
            if (!currentForLease || !isCurrent(currentForLease)) return;
            state = { ...state, localDraftAccess: "lost" };
            appendDiagnostic(writerConflictDiagnostic("ELEASELOST"), currentForLease.reportDiagnostic);
          }
        });
        constructingWriterLease = writerLease;
        hasWriter = await writerLease.acquire();
      } catch {
        writerLease = null;
        appendDiagnostic(fixedDiagnostic(
          "LOCAL_DRAFT_COORDINATION_UNAVAILABLE",
          "This browser cannot coordinate Local Draft writers safely. Editing is disabled."
        ), input.reportDiagnostic);
      }
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
        workspaceProjectId: localDraftNamespace(project),
        workspaceRoot: projectRoot(project.id),
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
        writerLease,
        unsubscribe: () => false,
        reportDiagnostic: input.reportDiagnostic,
        projectId: project.id,
        displayName: project.displayName
      };
      currentForLease = current;
      state = { ...state, localDraftAccess: hasWriter ? "writer" : "conflict" };
      if (!hasWriter && writerLease) appendDiagnostic(writerConflictDiagnostic("ELEASEHELD"), input.reportDiagnostic);
      current.unsubscribe = controller.on((event) => receiveEvent(current, event));
      owned = current;
      constructingProcessTable = null;
      constructingSupervisor = null;
      constructingController = null;
      constructingWriterLease = null;

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
        constructingSupervisor,
        constructingWriterLease
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
      state = {
        ...state,
        lifecycle: "disposed",
        projectId: null,
        previewUrl: null,
        ports: [],
        processes: [],
        localDraftAccess: "none",
        terminalProcessCount: 0,
        serverLogs: []
      };
      emit();
      listeners.clear();
      workspaceBundle.reset();
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
    try { await current.writerLease?.release(); } catch { failures.push("local-draft-writer"); }
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
        ports: [],
        processes: [],
        localDraftAccess: "none",
        terminalProcessCount: 0,
        serverLogs: []
      };
      emit();
      listeners.clear();
    }
    return true;
  }

  async function rollbackConstruction(
    controller: ControllerLike | null,
    processTable: ProcessTableLike | null,
    supervisor: SupervisorLike | null,
    writerLease: LocalDraftWriterLease | null
  ): Promise<boolean> {
    const failures: string[] = [];
    if (controller) try { controller.dispose(); } catch { failures.push("controller"); }
    if (supervisor) try {
      await withTimeout(supervisor.teardown(), dependencies.cleanupTimeoutMs ?? DEFAULT_CLEANUP_TIMEOUT_MS);
    } catch { failures.push("supervisor"); }
    if (processTable) try { processTable.teardown(); } catch { failures.push("process-table"); }
    if (writerLease) try { await writerLease.release(); } catch { failures.push("local-draft-writer"); }
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
    workflowDiagnostics = snapshot.diagnostics.map(normalizeDiagnostic).slice(-MAX_DIAGNOSTICS);
    const diagnostics = combinedDiagnostics();
    const processes = runtimeProcesses(current.controller.listShellProcesses());
    state = {
      ...state,
      workflowPhase: snapshot.phase,
      hmrState: snapshot.hmrState,
      serverLogs: snapshot.logs.slice(-100),
      previewUrl: snapshot.previewUrl,
      ports: snapshot.session && snapshot.previewUrl ? [{
        label: "Preview",
        port: snapshot.session.port,
        status: snapshot.session.serverState,
        url: snapshot.previewUrl
      }] : [],
      processes,
      diagnostics,
      terminalProcessCount: processes.length
    };
    emit();
  }

  function appendDiagnostic(diagnostic: RuntimeDiagnostic, callback?: (diagnostic: RuntimeDiagnostic) => void): void {
    adapterDiagnostics = [...adapterDiagnostics.filter((entry) => entry.code !== diagnostic.code), diagnostic].slice(-MAX_DIAGNOSTICS);
    state = { ...state, diagnostics: combinedDiagnostics() };
    emit();
    try { callback?.(diagnostic); } catch { /* consumer diagnostics must not break cleanup */ }
  }

  function removeAdapterDiagnostics(...codes: string[]): void {
    const removed = new Set(codes);
    adapterDiagnostics = adapterDiagnostics.filter((diagnostic) => !removed.has(diagnostic.code));
    state = { ...state, diagnostics: combinedDiagnostics() };
  }

  function combinedDiagnostics(): RuntimeDiagnostic[] {
    return [...adapterDiagnostics, ...workflowDiagnostics].slice(-MAX_DIAGNOSTICS);
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
    return {
      ...state,
      diagnostics: state.diagnostics.map((diagnostic) => ({ ...diagnostic, actions: [...diagnostic.actions] })),
      ports: state.ports.map((port) => ({ ...port })),
      processes: state.processes.map((process) => ({
        ...process,
        argv: [...process.argv],
        ...(process.terminalSize ? { terminalSize: { ...process.terminalSize } } : {})
      }))
    };
  }

  return { mount, subscribe, getState, terminal, recovery, workflow, workspace, dispose };
}

function createInitialState(): RuntimeViewState {
  return {
    generation: 0,
    lifecycle: "idle",
    projectId: null,
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

function runtimeProcesses(
  processes: ReturnType<PreviewWorkflowController["listShellProcesses"]>
): RuntimeProcessInfo[] {
  return processes.map((process) => ({
    argv: [...(process.argv ?? [])],
    command: process.command,
    cwd: process.cwd,
    ...(process.generation === undefined ? {} : { generation: process.generation }),
    pid: process.pid,
    status: process.status,
    terminalId: process.terminalId,
    ...(process.terminalSize ? { terminalSize: { ...process.terminalSize } } : {})
  }));
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
  const keys = Object.keys(project).sort();
  if (
    keys.length !== PROJECT_CONTEXT_KEYS.length
    || keys.some((key, index) => key !== PROJECT_CONTEXT_KEYS[index])
    || !UUID_V7_VALUE.test(project.id)
    || !UUID_V7_VALUE.test(project.storageScopeId)
    || !UUID_V7_VALUE.test(project.workspaceScopeId)
    || project.storageScopeId !== project.workspaceScopeId
    || !project.displayName.trim()
  ) {
    throw new RuntimeAdapterError("RUNTIME_PROJECT_INVALID", "Runtime Project context is incomplete.");
  }
  return project;
}

function localDraftNamespace(project: RuntimeMountInput["project"]): string {
  return `${project.workspaceScopeId}:${project.id}`;
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
    severity: level === "error" ? "error" : (function () {
    if (level === "warning" || level === "warn") {
        return ("warning");
    }
    return ("info");
})(),
    message: boundedText(redactRuntimeLog(input.message), MAX_DIAGNOSTIC_LENGTH),
    actions: normalizeRecoveryActions(input.recoveryActions)
  };
}

function fixedDiagnostic(code: string, message: string, actions: readonly RuntimeRecoveryAction[] = []): RuntimeDiagnostic {
  return { code, severity: "error", message, actions };
}

function writerConflictDiagnostic(code: "ELEASEHELD" | "ELEASELOST"): RuntimeDiagnostic {
  return fixedDiagnostic(
    code,
    code === "ELEASEHELD"
      ? "Another tab owns this Local Draft writer lease. You can inspect files, but editing is disabled."
      : "This tab released its Local Draft writer lease to another tab. Unsaved editor text is still visible here.",
    [{ kind: "resolve-writer-conflict", label: "Take over writer lease" }]
  );
}

function normalizeRecoveryActions(
  actions: PreviewWorkflowSnapshot["diagnostics"][number]["recoveryActions"]
): RuntimeRecoveryAction[] {
  const supported = new Set<RuntimeRecoveryActionKind>([
    "clear-cache",
    "reset-runtime",
    "resolve-writer-conflict",
    "restart-dev-server",
    "retry"
  ]);
  const seen = new Set<RuntimeRecoveryActionKind>();
  const normalized: RuntimeRecoveryAction[] = [];
  for (const action of actions ?? []) {
    if (!supported.has(action.kind as RuntimeRecoveryActionKind)) continue;
    const kind = action.kind as RuntimeRecoveryActionKind;
    if (seen.has(kind)) continue;
    seen.add(kind);
    normalized.push({ kind, label: boundedText(redactRuntimeLog(action.label), 80) });
  }
  return normalized;
}

function recoveryLabel(kind: RuntimeRecoveryActionKind): string {
  if (kind === "clear-cache") return "Retry cache cleanup";
  if (kind === "resolve-writer-conflict") return "Retry writer takeover";
  if (kind === "reset-runtime" || kind === "restart-dev-server") return "Retry dev server restart";
  return "Retry Preview";
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
