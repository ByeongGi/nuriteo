import assert from "node:assert/strict";

import {
  RuntimeAdapterError,
  createRuntimeAdapter,
  type RuntimeMountInput
} from "../src/runtime/runtime-adapter.ts";
import type {
  PreviewWorkflowEvent,
  PreviewWorkflowListener,
  PreviewWorkflowSnapshot
} from "@nuriteo/preview-service";

const hash = "a".repeat(64);
const mountInput: RuntimeMountInput = {
  project: { id: "project-a", localDraftKey: "draft-a", displayName: "Project A" },
  assets: {
    systemWorkerUrl: `/runtime/${hash}/system-worker.js`,
    processWorkerUrl: `/runtime/${hash}/process-worker.js`,
    systemWasmUrl: `/runtime/${hash}/system.wasm`,
    previewServiceWorkerUrl: `/runtime/${hash}/preview-sw.js`
  }
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
  stopPreviewPort(): boolean { return true; }
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
    createController() {
      const controller = new FakeController(cleanup);
      controllers.push(controller);
      return controller;
    }
  });
  return { adapter, cleanup, controllers, counts: () => ({ supervisorCount, processCount }) };
}

{
  const { adapter, cleanup, controllers } = harness();
  assert.throws(() => adapter.terminal.input("before-ready"), (error: unknown) =>
    error instanceof RuntimeAdapterError && error.code === "RUNTIME_NOT_READY");
  const mounted = await adapter.mount(mountInput);
  assert.equal(mounted.lifecycle, "ready");
  assert.equal(mounted.projectId, "project-a");
  assert.equal(mounted.generation, 1);
  controllers[0]?.emit(snapshot({ phase: "preview_ready", previewUrl: "https://preview.test" }));
  assert.equal(adapter.getState().previewUrl, "https://preview.test");
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
  const { adapter, cleanup } = harness();
  adapter.subscribe(() => { throw new Error("consumer failed"); });
  assert.equal((await adapter.mount(mountInput)).lifecycle, "ready");
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
  assert.equal((await mounting).lifecycle, "disposed");
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
  await adapter.mount({ ...mountInput, project: { ...mountInput.project, id: "project-b" } });
  staleController?.emit(snapshot({ phase: "preview_ready", previewUrl: "https://stale.test" }));
  assert.equal(adapter.getState().generation, 2);
  assert.equal(adapter.getState().projectId, "project-b");
  assert.equal(adapter.getState().previewUrl, null);
  await adapter.dispose();
}

{
  const { adapter, counts } = harness();
  await assert.rejects(
    adapter.mount({
      ...mountInput,
      assets: { ...mountInput.assets, processWorkerUrl: "https://evil.test/process.js" }
    }),
    (error: unknown) => error instanceof RuntimeAdapterError && error.code === "RUNTIME_BOOT_FAILED"
  );
  assert.deepEqual(counts(), { supervisorCount: 0, processCount: 0 }, "invalid assets fail before resources are created");
  assert.equal(JSON.stringify(adapter.getState()).includes("evil.test"), false);
}

{
  const rollback: string[] = [];
  const adapter = createRuntimeAdapter({
    origin: () => "https://nuriteo.test",
    createProcessTable: () => ({ teardown: () => { rollback.push("process"); } }),
    createSupervisor: () => { throw new Error("supervisor factory failed with secret=hidden"); }
  });
  await assert.rejects(adapter.mount(mountInput), /Runtime could not start/u);
  assert.deepEqual(rollback, ["process"]);
  assert.equal(JSON.stringify(adapter.getState()).includes("secret"), false);
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
      assets: { ...mountInput.assets, systemWasmUrl: `${mountInput.assets.systemWasmUrl}?variant=mutable` }
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

console.log("runtime adapter tests ok");
