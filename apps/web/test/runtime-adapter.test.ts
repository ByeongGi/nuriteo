import assert from "node:assert/strict";

import {
  RuntimeAdapterError,
  createRuntimeAdapter,
  type RuntimeMountInput
} from "../src/runtime/runtime-adapter.ts";
import type {
  FileSystemTree,
  PreviewWorkflowControllerOptions,
  PreviewWorkflowEvent,
  PreviewWorkflowListener,
  PreviewWorkflowSnapshot
} from "@nuriteo/preview-service";

const hash = "a".repeat(64);
const scopeId = "0199ee6c-c777-7000-8000-00000000a001";
const draftProjectId = "0199ee6c-c777-7000-8000-00000000a002";
const otherProjectId = "0199ee6c-c777-7000-8000-00000000a003";
const otherScopeId = "0199ee6c-c777-7000-8000-00000000a004";
const mountInput: RuntimeMountInput = {
  project: {
    id: draftProjectId,
    storageScopeId: scopeId,
    workspaceScopeId: scopeId,
    displayName: "Project A"
  },
  assets: {
    systemWorkerUrl: new URL(`/runtime/${hash}/system-worker.js`, "https://nuriteo.test"),
    processWorkerUrl: new URL(`/runtime/${hash}/process-worker.js`, "https://nuriteo.test"),
    systemWasmUrl: new URL(`/runtime/${hash}/system.wasm`, "https://nuriteo.test"),
    previewServiceWorkerUrl: new URL(`/runtime/${hash}/preview-sw.js`, "https://nuriteo.test")
  },
  policy: { bootTimeoutMs: 2_000, relayTimeoutMs: 2_000, memoryLimitBytes: 64 * 1024 * 1024 },
  reportDiagnostic() {}
};

function snapshot(overrides: Partial<PreviewWorkflowSnapshot> = {}): PreviewWorkflowSnapshot {
  return {
    phase: "idle",
    projectId: null,
    manager: null,
    template: null,
    source: null,
    health: null,
    packageManagerOverride: null,
    previewUrl: null,
    hmrState: "idle",
    install: null,
    build: null,
    lastError: null,
    diagnostics: [],
    logs: [],
    editor: null,
    project: null,
    workflow: null,
    session: null,
    ...overrides
  };
}

class FakeController {
  listener: PreviewWorkflowListener | null = null;
  current = snapshot();
  disposed = 0;
  terminals = new Set<string>();
  savedText: { path: string; data: string } | null = null;
  readonly cleanup: string[];

  constructor(cleanup: string[]) { this.cleanup = cleanup; }
  on(listener: PreviewWorkflowListener): () => boolean {
    this.listener = listener;
    return () => {
      this.cleanup.push("unsubscribe");
      const existed = this.listener === listener;
      if (existed) this.listener = null;
      return existed;
    };
  }
  emit(next: PreviewWorkflowSnapshot): void {
    this.current = next;
    this.listener?.({ type: "phase", detail: {}, snapshot: next } as PreviewWorkflowEvent);
  }
  getSnapshot(): PreviewWorkflowSnapshot { return this.current; }
  async runShellCommand(_command: string, terminalId = "default"): Promise<unknown> {
    this.terminals.add(terminalId);
    return { exitCode: 0 };
  }
  writeShellInput(): boolean { return true; }
  resizeShell(): void {}
  signalShell(): boolean { return true; }
  closeShell(terminalId: string): boolean { return this.terminals.delete(terminalId); }
  listShellProcesses(): Array<{ terminalId: string }> {
    return [...this.terminals].map((terminalId) => ({ terminalId }));
  }
  async restartDev(): Promise<PreviewWorkflowSnapshot> { return this.current; }
  async runPreview(): Promise<PreviewWorkflowSnapshot> {
    this.current = snapshot({ phase: "hmr_connected", hmrState: "connected", previewUrl: "https://nuriteo.test/previews/project/" });
    return this.current;
  }
  saveTextFile(path: string, data: string): PreviewWorkflowSnapshot {
    this.savedText = { path, data };
    return this.current;
  }
  stopPreviewPort(): boolean { return true; }
  loadTemplate(): PreviewWorkflowSnapshot {
    this.current = snapshot({ phase: "template_loaded" });
    return this.current;
  }
  exportTreeJson(): FileSystemTree {
    return {
      src: { directory: { "main.tsx": { file: { contents: "export default function App() {}\n" } } } },
      "package.json": { file: { contents: "{\"scripts\":{\"dev\":\"vite\"}}\n" } }
    };
  }
  dispose(): void { this.disposed += 1; this.terminals.clear(); this.cleanup.push("controller"); }
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, decline) => { resolve = accept; reject = decline; });
  return { promise, resolve, reject };
}

function harness(boot: Promise<unknown> = Promise.resolve({})) {
  const cleanup: string[] = [];
  const controllers: FakeController[] = [];
  const controllerOptions: PreviewWorkflowControllerOptions[] = [];
  let supervisorCount = 0;
  let processCount = 0;
  const adapter = createRuntimeAdapter({
    origin: () => "https://nuriteo.test",
    createSupervisor() {
      supervisorCount += 1;
      return {
        boot: () => boot,
        async teardown() { cleanup.push("supervisor"); }
      };
    },
    createProcessTable() {
      processCount += 1;
      return { teardown() { cleanup.push("process"); } };
    },
    createController(options) {
      controllerOptions.push(options);
      const controller = new FakeController(cleanup);
      controllers.push(controller);
      return controller;
    }
  });
  return {
    adapter,
    cleanup,
    controllers,
    controllerOptions,
    counts: () => ({ supervisorCount, processCount })
  };
}

{
  const { adapter, cleanup, controllers, controllerOptions } = harness();
  assert.throws(() => adapter.terminal.input("before-ready"), (error: unknown) =>
    error instanceof RuntimeAdapterError && error.code === "RUNTIME_NOT_READY");
  await adapter.mount(mountInput);
  assert.equal(adapter.getState().lifecycle, "ready");
  assert.equal(adapter.getState().projectId, draftProjectId);
  assert.equal(adapter.getState().generation, 1);
  assert.equal(controllerOptions[0]?.workspaceProjectId, `${scopeId}:${draftProjectId}`);
  assert.equal(controllerOptions[0]?.workspaceRoot, `/workspace/projects/${draftProjectId}`);
  controllers[0]?.emit(snapshot({ phase: "preview_ready", previewUrl: "https://preview.test" }));
  assert.equal(adapter.getState().previewUrl, "https://preview.test");
  const materialized = await adapter.workspace.materializeTemplate("vite-react");
  assert.equal(materialized.status, "ready");
  assert.deepEqual(materialized.files.map((file) => file.path), ["package.json", "src/main.tsx"]);
  assert.equal(adapter.workspace.readText("src/main.tsx"), "export default function App() {}\n");
  const previewState = await adapter.workflow.start();
  assert.equal(previewState.workflowPhase, "hmr_connected");
  assert.equal(previewState.hmrState, "connected");
  const editedState = adapter.workspace.writeText("src/main.tsx", "export default function App() { return 'edited'; }\n");
  assert.equal(editedState.hmrState, "connected");
  assert.deepEqual(controllers[0]?.savedText, {
    path: "src/main.tsx",
    data: "export default function App() { return 'edited'; }\n"
  });
  assert.match(adapter.workspace.readText("src/main.tsx"), /edited/u);
  assert.throws(
    () => adapter.workspace.writeText("src/main.tsx", "x".repeat(1024 * 1024 + 1)),
    (error: unknown) => error instanceof RuntimeAdapterError && error.code === "RUNTIME_EDIT_LIMIT_EXCEEDED"
  );
  await adapter.terminal.run("pnpm dev", "terminal-1");
  assert.equal(adapter.terminal.activeCount(), 1);
  const firstDispose = adapter.dispose();
  const secondDispose = adapter.dispose();
  assert.equal(firstDispose, secondDispose, "dispose must return the same cleanup promise");
  await firstDispose;
  assert.deepEqual(cleanup, ["unsubscribe", "controller", "process", "supervisor"]);
  assert.equal(adapter.terminal.activeCount(), 0);
  assert.equal(adapter.getState().lifecycle, "disposed");
}

{
  const { adapter, controllers } = harness();
  await adapter.mount(mountInput);
  const controller = controllers[0];
  assert.ok(controller);
  controller.exportTreeJson = () => ({ "..": { file: { contents: "not allowed" } } });
  await assert.rejects(
    adapter.workspace.materializeTemplate("vite-react"),
    (error: unknown) => error instanceof RuntimeAdapterError
      && error.code === "RUNTIME_MATERIALIZATION_FAILED"
      && !String(error).includes("not allowed")
  );
  assert.deepEqual(adapter.workspace.getState(), {
    errorCode: "RUNTIME_MATERIALIZATION_FAILED",
    files: [],
    projectId: draftProjectId,
    root: `/workspace/projects/${draftProjectId}`,
    status: "failed",
    totalBytes: 0
  });
  controller.exportTreeJson = () => ({});
  await assert.rejects(
    adapter.workspace.materializeTemplate("vite-react"),
    (error: unknown) => error instanceof RuntimeAdapterError
      && error.code === "RUNTIME_MATERIALIZATION_FAILED"
  );
  controller.exportTreeJson = () => ({
    "oversized.txt": { file: { contents: "x".repeat(1024 * 1024 + 1) } }
  });
  await assert.rejects(
    adapter.workspace.materializeTemplate("vite-react"),
    (error: unknown) => error instanceof RuntimeAdapterError
      && error.code === "RUNTIME_MATERIALIZATION_FAILED"
  );
  assert.equal(adapter.workspace.getState().status, "failed");
  assert.deepEqual(adapter.workspace.getState().files, []);
  await adapter.dispose();
}

{
  const { adapter, cleanup } = harness();
  adapter.subscribe(() => { throw new Error("consumer failed"); });
  await adapter.mount(mountInput);
  assert.equal(adapter.getState().lifecycle, "ready");
  await adapter.dispose();
  assert.deepEqual(cleanup, ["unsubscribe", "controller", "process", "supervisor"]);
  assert.equal(adapter.getState().lifecycle, "disposed");
}

{
  const boot = deferred<unknown>();
  const { adapter, controllers } = harness(boot.promise);
  const mounting = adapter.mount(mountInput);
  await Promise.resolve();
  await adapter.dispose();
  await mounting;
  assert.equal(adapter.getState().lifecycle, "disposed");
  boot.resolve({});
  controllers[0]?.emit(snapshot({ phase: "preview_ready", previewUrl: "https://stale.test" }));
  await Promise.resolve();
  assert.equal(adapter.getState().previewUrl, null, "late boot and controller events must be ignored");
}

{
  const { adapter, controllers } = harness();
  await adapter.mount(mountInput);
  const staleController = controllers[0];
  await adapter.dispose();
  await adapter.mount({ ...mountInput, project: { ...mountInput.project, id: otherProjectId } });
  staleController?.emit(snapshot({ phase: "preview_ready", previewUrl: "https://stale.test" }));
  assert.equal(adapter.getState().generation, 2);
  assert.equal(adapter.getState().projectId, otherProjectId);
  assert.equal(adapter.getState().previewUrl, null);
  await adapter.dispose();
}

{
  const { adapter, counts } = harness();
  await assert.rejects(
    adapter.mount({
      ...mountInput,
      assets: { ...mountInput.assets, processWorkerUrl: new URL("https://evil.test/process.js") }
    }),
    (error: unknown) => error instanceof RuntimeAdapterError && error.code === "RUNTIME_BOOT_FAILED"
  );
  assert.deepEqual(counts(), { supervisorCount: 0, processCount: 0 }, "invalid assets fail before resources are created");
  assert.equal(JSON.stringify(adapter.getState()).includes("evil.test"), false);
}

{
  const { adapter, counts } = harness();
  const crossProject = {
    ...mountInput.project,
    localDraftKey: `${scopeId}:${otherProjectId}`
  } as unknown as RuntimeMountInput["project"];
  await assert.rejects(
    adapter.mount({ ...mountInput, project: crossProject }),
    (error: unknown) => error instanceof RuntimeAdapterError && error.code === "RUNTIME_PROJECT_INVALID"
  );
  assert.deepEqual(counts(), { supervisorCount: 0, processCount: 0 }, "cross-Project legacy namespace fails before resource construction");
}

{
  const { adapter, counts } = harness();
  await assert.rejects(
    adapter.mount({
      ...mountInput,
      project: { ...mountInput.project, workspaceScopeId: otherScopeId }
    }),
    (error: unknown) => error instanceof RuntimeAdapterError && error.code === "RUNTIME_PROJECT_INVALID"
  );
  assert.deepEqual(counts(), { supervisorCount: 0, processCount: 0 }, "cross-Workspace context fails before resource construction");
}

{
  const { adapter, counts } = harness();
  await assert.rejects(
    adapter.mount({ ...mountInput, project: { ...mountInput.project, id: "../project-b" } }),
    (error: unknown) => error instanceof RuntimeAdapterError && error.code === "RUNTIME_PROJECT_INVALID"
  );
  assert.deepEqual(counts(), { supervisorCount: 0, processCount: 0 }, "unsafe Project roots fail before resource construction");
}

{
  const rollback: string[] = [];
  const adapter = createRuntimeAdapter({
    origin: () => "https://nuriteo.test",
    createProcessTable: () => ({ teardown: () => { rollback.push("process"); } }),
    createSupervisor: () => { throw new Error("supervisor factory failed with secret=hidden"); }
  });
  let publicError: unknown;
  try { await adapter.mount(mountInput); } catch (error) { publicError = error; }
  assert.ok(publicError instanceof RuntimeAdapterError);
  assert.equal(publicError.cause, undefined);
  assert.equal(String(publicError).includes("hidden"), false);
  assert.deepEqual(rollback, ["process"]);
  assert.equal(JSON.stringify(adapter.getState()).includes("secret"), false);
}

{
  const calls = { subscription: 0, controller: 0, process: 0, supervisor: 0 };
  const controller = new FakeController([]);
  controller.on = () => () => {
    calls.subscription += 1;
    if (calls.subscription === 1) throw new Error("unsubscribe cleanup failed");
    return true;
  };
  controller.dispose = () => {
    calls.controller += 1;
    if (calls.controller === 1) throw new Error("controller cleanup failed secret=hidden");
  };
  const adapter = createRuntimeAdapter({
    origin: () => "https://nuriteo.test",
    createProcessTable: () => ({ teardown() {
      calls.process += 1;
      if (calls.process === 1) throw new Error("process cleanup failed");
    } }),
    createSupervisor: () => ({
      boot: async () => ({}),
      async teardown() {
        calls.supervisor += 1;
        if (calls.supervisor === 1) throw new Error("supervisor cleanup failed");
      }
    }),
    createController: () => controller
  });
  await adapter.mount(mountInput);
  await adapter.dispose();
  assert.deepEqual(calls, { subscription: 1, controller: 1, process: 1, supervisor: 1 }, "cleanup must continue after every failure");
  assert.equal(adapter.getState().lifecycle, "failed");
  assert.equal(adapter.getState().diagnostics.at(-1)?.code, "RUNTIME_CLEANUP_FAILED");
  assert.equal(JSON.stringify(adapter.getState()).includes("hidden"), false);
  await assert.rejects(adapter.mount(mountInput), /cannot mount/u);
  await adapter.dispose();
  assert.deepEqual(calls, { subscription: 2, controller: 2, process: 2, supervisor: 2 });
  assert.equal(adapter.getState().lifecycle, "disposed");
}

{
  const adapter = createRuntimeAdapter({
    origin: () => "https://nuriteo.test",
    createProcessTable: () => ({ teardown() { throw new Error("rollback failed"); } }),
    createSupervisor: () => { throw new Error("construction failed"); }
  });
  await assert.rejects(adapter.mount(mountInput), /Runtime could not start/u);
  assert.equal(adapter.getState().lifecycle, "failed");
  await adapter.dispose();
  assert.equal(adapter.getState().lifecycle, "failed", "unreleased construction resources require reload");
  await assert.rejects(adapter.mount(mountInput), /cannot mount/u);
}

{
  const rollback: string[] = [];
  const adapter = createRuntimeAdapter({
    origin: () => "https://nuriteo.test",
    createProcessTable: () => ({ teardown: () => { rollback.push("process"); } }),
    createSupervisor: () => ({
      boot: async () => ({}),
      teardown: async () => { rollback.push("supervisor"); }
    }),
    createController: () => { throw new Error("controller factory failed"); }
  });
  await assert.rejects(adapter.mount(mountInput), /Runtime could not start/u);
  assert.deepEqual(rollback, ["supervisor", "process"], "construction rollback must use reverse creation order");
}

{
  const rollback: string[] = [];
  const controller = new FakeController(rollback);
  controller.on = () => { throw new Error("subscription failed"); };
  const adapter = createRuntimeAdapter({
    origin: () => "https://nuriteo.test",
    createProcessTable: () => ({ teardown: () => { rollback.push("process"); } }),
    createSupervisor: () => ({
      boot: async () => ({}),
      teardown: async () => { rollback.push("supervisor"); }
    }),
    createController: () => controller
  });
  await assert.rejects(adapter.mount(mountInput), /Runtime could not start/u);
  assert.deepEqual(rollback, ["controller", "supervisor", "process"]);
}


{
  const { adapter, counts } = harness();
  await assert.rejects(
    adapter.mount({
      ...mountInput,
      assets: { ...mountInput.assets, systemWasmUrl: new URL(`${mountInput.assets.systemWasmUrl}?variant=mutable`) }
    }),
    /Runtime could not start/u
  );
  assert.deepEqual(counts(), { supervisorCount: 0, processCount: 0 });
}

{
  const { adapter, controllers } = harness();
  await adapter.mount(mountInput);
  controllers[0]?.emit(snapshot({
    diagnostics: [{ code: "AUTH", level: "error", message: `token=super-secret ${"x".repeat(700)}` }]
  }));
  const diagnostic = adapter.getState().diagnostics[0];
  assert.ok(diagnostic);
  assert.ok(diagnostic.message.length <= 512);
  assert.equal(diagnostic.message.includes("super-secret"), false);
  await adapter.dispose();
}

{
  type WorkerListener = (event: MessageEvent | ErrorEvent) => void;
  class ActualBoundaryWorker {
    static instances: ActualBoundaryWorker[] = [];
    readonly listeners = new Map<string, WorkerListener[]>();
    readonly name: string;
    terminated = false;
    readonly messages: Array<Record<string, unknown>> = [];

    constructor(_url: string | URL, options?: WorkerOptions) {
      this.name = options?.name ?? "worker";
      ActualBoundaryWorker.instances.push(this);
    }
    addEventListener(type: string, listener: WorkerListener): void {
      this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
    }
    removeEventListener(type: string, listener: WorkerListener): void {
      this.listeners.set(type, (this.listeners.get(type) ?? []).filter((entry) => entry !== listener));
    }
    postMessage(message: {
      type?: string;
      pid?: number;
      generation?: number;
      argv?: string[];
      cwd?: string;
      env?: Record<string, string>;
      systemWasmUrl?: string;
    }): void {
      this.messages.push(message);
      if (message.type === "initialize-runtime") {
        queueMicrotask(() => this.emit({ data: { type: "runtime-initialized" } } as MessageEvent));
        return;
      }
      if (message.type === "start") {
        queueMicrotask(() => {
          this.emit({ data: { type: "ready", pid: message.pid, generation: message.generation } } as MessageEvent);
          queueMicrotask(() => {
            const data = message.argv?.[0] === "env"
              ? `${Object.entries(message.env ?? {}).map(([name, value]) => `${name}=${value}`).join("\n")}\n`
              : `${message.cwd}\n`;
            this.emit({ data: { type: "stdout", data, pid: message.pid, generation: message.generation } } as MessageEvent);
            this.emit({ data: { type: "exit", code: 0, pid: message.pid, generation: message.generation } } as MessageEvent);
          });
        });
        return;
      }
      if (message.type !== "boot") return;
      queueMicrotask(() => {
        const event = {
          data: {
            type: "ready",
            protocolVersion: 1,
            role: this.name.includes("system") ? "system" : "process",
            details: {}
          }
        } as MessageEvent;
        for (const listener of this.listeners.get("message") ?? []) listener(event);
      });
    }
    emit(event: MessageEvent): void {
      for (const listener of this.listeners.get("message") ?? []) listener(event);
    }
    terminate(): void { this.terminated = true; }
  }

  const originalWorker = globalThis.Worker;
  Object.defineProperty(globalThis, "Worker", { configurable: true, value: ActualBoundaryWorker });
  try {
    const adapter = createRuntimeAdapter({ origin: () => "https://nuriteo.test" });
    await adapter.mount(mountInput);
    assert.equal(adapter.getState().lifecycle, "ready");
    assert.equal(ActualBoundaryWorker.instances.length, 2, "one system and one process supervisor Worker are created");
    const workspace = await adapter.workspace.materializeTemplate("vite-react");
    assert.equal(workspace.projectId, draftProjectId);
    assert.equal(workspace.root, `/workspace/projects/${draftProjectId}`);
    assert.ok(workspace.files.some((file) => file.path === "src/App.tsx"));
    assert.match(adapter.workspace.readText("src/App.tsx"), /function App/u);
    const output: string[] = [];
    const result = await adapter.terminal.run("worker-pwd", "terminal-actual", (chunk) => output.push(chunk.data)) as { exitCode: number; stdout: string };
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, `/workspace/projects/${draftProjectId}\n`);
    assert.deepEqual(output, [`/workspace/projects/${draftProjectId}\n`]);
    assert.equal(ActualBoundaryWorker.instances.length, 3, "terminal command owns a third process Worker");
    assert.deepEqual(
      ActualBoundaryWorker.instances[2]?.messages.slice(0, 2).map((message) => message.type),
      ["initialize-runtime", "start"]
    );
    assert.equal(
      ActualBoundaryWorker.instances[2]?.messages[0]?.systemWasmUrl,
      mountInput.assets.systemWasmUrl.toString()
    );
    const envResult = await adapter.terminal.run("worker-env", "terminal-env") as { exitCode: number; stdout: string };
    assert.equal(envResult.exitCode, 0);
    assert.doesNotMatch(envResult.stdout, /cookie|credential|password|secret|token/iu);
    assert.equal(ActualBoundaryWorker.instances.length, 4, "each terminal owns an isolated process Worker");
    assert.equal(ActualBoundaryWorker.instances[3]?.messages[1]?.cwd, `/workspace/projects/${draftProjectId}`);
    assert.deepEqual(ActualBoundaryWorker.instances[3]?.messages[1]?.env, {
      PATH: "/workspace/node_modules/.bin:/bin"
    });
    await adapter.dispose();
    assert.equal(adapter.getState().terminalProcessCount, 0);
    assert.equal(ActualBoundaryWorker.instances.every((worker) => worker.terminated), true);
    assert.equal(ActualBoundaryWorker.instances.every((worker) =>
      [...worker.listeners.values()].every((listeners) => listeners.length === 0)), true);
  } finally {
    if (originalWorker) Object.defineProperty(globalThis, "Worker", { configurable: true, value: originalWorker });
    else Reflect.deleteProperty(globalThis, "Worker");
  }
}

console.log("runtime adapter tests ok");
