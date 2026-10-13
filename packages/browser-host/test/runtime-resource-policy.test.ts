import assert from "node:assert/strict";

import {
  assertBrowserRuntimeResourceAdmission,
  BrowserRuntimeResourceError,
  createBoundedWebAssemblyMemoryConstructor,
  WASM_PAGE_BYTES
} from "../../browser-host/src/resources/index.ts";
import { BrowserRuntimeSupervisor } from "../../browser-host/src/supervisor.ts";

const admission = assertBrowserRuntimeResourceAdmission({
  artifactBytes: 8,
  sourceBytes: 4,
  wasmMemoryBytes: 16,
  workspaceBytes: 32
}, 64);
assert.equal(admission.totalBytes, 60);
assert.throws(
  () => assertBrowserRuntimeResourceAdmission({ workspaceBytes: 65 }, 64),
  (error) => error instanceof BrowserRuntimeResourceError
    && error.code === "ERUNTIME_MEMORY_ADMISSION"
    && error.observedBytes === 65
    && error.limitBytes === 64
);
assert.throws(
  () => assertBrowserRuntimeResourceAdmission({ artifactBytes: -1 }),
  (error) => error instanceof BrowserRuntimeResourceError && error.code === "ERUNTIME_RESOURCE_ESTIMATE"
);

const BoundedMemory = createBoundedWebAssemblyMemoryConstructor(2 * WASM_PAGE_BYTES);
const memory = new BoundedMemory({ initial: 1 });
assert.equal(memory.buffer.byteLength, WASM_PAGE_BYTES);
assert.equal(memory.grow(1), 1);
assert.throws(() => memory.grow(1), RangeError);
assert.throws(
  () => new BoundedMemory({ initial: 1, maximum: 3 }),
  (error) => error instanceof BrowserRuntimeResourceError && error.code === "ERUNTIME_WASM_MEMORY"
);

type Listener = (event: MessageEvent | ErrorEvent) => void;

class MockWorker {
  static instances: MockWorker[] = [];
  static hangBoot = false;
  static throwOnName: string | null = null;
  readonly listeners = new Map<string, Listener[]>();
  readonly messages: Array<Record<string, unknown>> = [];
  readonly name: string;
  terminated = false;
  hangRuns = true;

  constructor(_url: string | URL, options?: WorkerOptions) {
    this.name = options?.name || "worker";
    if (this.name === MockWorker.throwOnName) throw new Error(`constructor failed for ${this.name}`);
    MockWorker.instances.push(this);
  }

  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) || []), listener]);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, (this.listeners.get(type) || []).filter((entry) => entry !== listener));
  }

  postMessage(message: { type?: string; [key: string]: unknown }): void {
    this.messages.push(message);
    if (message.type === "boot") {
      if (MockWorker.hangBoot) return;
      queueMicrotask(() => this.emit("message", {
        data: {
          type: "ready",
          protocolVersion: 1,
          role: this.name.includes("system") ? "system" : "process",
          details: {}
        }
      } as MessageEvent));
      return;
    }
    if (message.type === "run" && !this.hangRuns) {
      queueMicrotask(() => this.emit("message", { data: { type: "run-result", ok: true } } as MessageEvent));
    }
  }

  terminate(): void {
    this.terminated = true;
  }

  emit(type: string, event: MessageEvent | ErrorEvent): void {
    for (const listener of this.listeners.get(type) || []) listener(event);
  }
}

const originalWorker = globalThis.Worker;
const originalSharedArrayBuffer = globalThis.SharedArrayBuffer;
Object.defineProperty(globalThis, "Worker", { configurable: true, value: MockWorker });
try {
  Object.defineProperty(globalThis, "SharedArrayBuffer", { configurable: true, value: undefined });
  const unavailable = new BrowserRuntimeSupervisor({
    processWorkerUrl: "http://localhost/process-worker.ts",
    systemWorkerUrl: "http://localhost/system-worker.ts"
  });
  await assert.rejects(unavailable.boot(), /SharedArrayBuffer is unavailable/);
  assert.equal(MockWorker.instances.length, 0, "sync-channel preflight must happen before Worker acquisition");
  assert.equal(unavailable.metrics.activeWorkers, 0);
  Object.defineProperty(globalThis, "SharedArrayBuffer", { configurable: true, value: originalSharedArrayBuffer });

  MockWorker.throwOnName = "nuriteo-process-0";
  const partial = new BrowserRuntimeSupervisor({
    processWorkerUrl: "http://localhost/process-worker.ts",
    systemWorkerUrl: "http://localhost/system-worker.ts"
  });
  await assert.rejects(partial.boot(), /Runtime boot failed/);
  const partiallyCreated = MockWorker.instances.at(-1)!;
  assert.equal(partiallyCreated.name, "nuriteo-system");
  assert.equal(partiallyCreated.terminated, true);
  assert.equal([...partiallyCreated.listeners.values()].every((listeners) => listeners.length === 0), true);
  assert.equal(partial.metrics.activeWorkers, 0);
  MockWorker.throwOnName = null;

  const supervisor = new BrowserRuntimeSupervisor({
    memoryLimitBytes: 64,
    processWorkerUrl: "http://localhost/process-worker.ts",
    systemWorkerUrl: "http://localhost/system-worker.ts",
    systemWasmUrl: "http://localhost/runtime/system.wasm",
    timeoutMs: 20
  });
  await supervisor.boot({ disableSyncChannel: true });
  const processBoot = MockWorker.instances.find((worker) => worker.name.includes("process"))?.messages[0];
  assert.equal(processBoot?.systemWasmUrl, "http://localhost/runtime/system.wasm");
  assert.throws(
    () => supervisor.run("12345", { resourceEstimate: { workspaceBytes: 60 } }),
    (error) => error instanceof BrowserRuntimeResourceError && error.code === "ERUNTIME_MEMORY_ADMISSION"
  );
  assert.equal(supervisor.status, "ready", "admission rejection must not disturb a healthy runtime");
  assert.equal(supervisor.metrics.admissionRejections, 1);
  await assert.rejects(supervisor.run("", { timeoutMs: 5 }), /process worker request timeout/);
  assert.equal(supervisor.status, "stopped");
  assert.equal(supervisor.metrics.activeWorkers, 0);
  assert.equal(supervisor.metrics.pendingRequests, 0);
  assert.equal(supervisor.metrics.watchdogTerminations, 1);
  assert.equal(MockWorker.instances.every((worker) => worker.terminated), true);

  await supervisor.boot({ disableSyncChannel: true });
  MockWorker.instances.at(-1)!.hangRuns = false;
  await supervisor.run("", { timeoutMs: 20, resourceEstimate: { workspaceBytes: 32 } });
  assert.equal(supervisor.status, "ready", "fresh workers must recover after watchdog termination");
  assert.equal(supervisor.metrics.lastAdmissionBytes, 32);
  await supervisor.teardown();

  MockWorker.hangBoot = true;
  const cancelled = new BrowserRuntimeSupervisor({
    processWorkerUrl: "http://localhost/process-worker.ts",
    systemWorkerUrl: "http://localhost/system-worker.ts",
    timeoutMs: 60_000
  });
  const pendingBoot = cancelled.boot({ disableSyncChannel: true });
  await cancelled.teardown();
  await assert.rejects(pendingBoot, /boot cancelled/);
  assert.equal(cancelled.metrics.teardownCount, 1, "boot catch must not double-count explicit teardown");
  assert.equal(MockWorker.instances.slice(-2).every((worker) =>
    [...worker.listeners.values()].every((listeners) => listeners.length === 0)), true);
} finally {
  Object.defineProperty(globalThis, "SharedArrayBuffer", { configurable: true, value: originalSharedArrayBuffer });
  if (originalWorker) Object.defineProperty(globalThis, "Worker", { configurable: true, value: originalWorker });
  else Reflect.deleteProperty(globalThis, "Worker");
}

console.log("browser runtime resource policy test ok");
