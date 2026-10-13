import assert from "node:assert/strict";

import { HostProcessTable } from "../../../packages/browser-host/src/index.ts";
import { createPreviewWorkflowController } from "@nuriteo/workspace-runtime";

class HangingWorker {
  readonly listeners = new Map<string, Array<(event: Event) => void>>();
  terminated = false;

  addEventListener(type: string, listener: (event: Event) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  removeEventListener(type: string, listener: (event: Event) => void): void {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((entry) => entry !== listener));
  }

  postMessage(): void { /* intentionally pending until teardown */ }

  terminate(): void {
    this.terminated = true;
  }
}

const workers: HangingWorker[] = [];
const processTable = new HostProcessTable({
  workerFactory() {
    const worker = new HangingWorker();
    workers.push(worker);
    return worker;
  }
});
const prepared = processTable.prepare({ url: "worker://runtime/process" });
const pendingStart = processTable.start(prepared.pid);
const controller = createPreviewWorkflowController({ terminalProcessTable: processTable });
let eventCount = 0;
controller.on(() => { eventCount += 1; });
controller.loadViteReactTemplate({ label: "Disposable Project" });
const workflow = controller.getSnapshot().workflow;
assert.ok(workflow);
let stopCount = 0;
const originalStop = workflow.stopDevServer.bind(workflow);
workflow.stopDevServer = () => {
  stopCount += 1;
  return originalStop();
};

controller.log("before dispose");
assert.ok(eventCount > 0);
controller.dispose();
controller.dispose();
const countAfterDispose = eventCount;
controller.log("after dispose");

assert.equal(eventCount, countAfterDispose, "disposed controller must clear listeners");
assert.equal(stopCount, 1, "workflow dev server cleanup must be idempotent");
assert.equal(controller.getSnapshot().workflow, null);
assert.equal(controller.getSnapshot().project, null);
assert.deepEqual(processTable.list({ activeOnly: true }), []);
assert.equal((await pendingStart).status, "killed");
assert.equal(workers.every((worker) => worker.terminated), true);
assert.equal(controller.on(() => undefined)(), false, "disposed controller must reject new listeners");

{
  let resolveBuffer!: (value: ArrayBuffer) => void;
  const arrayBuffer = new Promise<ArrayBuffer>((resolve) => { resolveBuffer = resolve; });
  const importing = createPreviewWorkflowController();
  const pendingImport = importing.importZipFile({ arrayBuffer: () => arrayBuffer } as Blob);
  importing.dispose();
  resolveBuffer(new ArrayBuffer(0));
  await assert.rejects(pendingImport, /operation cancelled/u);
  assert.equal(importing.getSnapshot().project, null, "late import completion must not recreate Project state");
}

{
  const originalLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
  Object.defineProperty(globalThis, "location", { configurable: true, value: { origin: "https://nuriteo.test" } });
  const restarting = createPreviewWorkflowController();
  try {
    restarting.loadViteReactTemplate();
    restarting.getSnapshot().workflow?.install();
    const pendingRestart = restarting.restartDev();
    restarting.dispose();
    await assert.rejects(pendingRestart, /operation cancelled/u);
    assert.equal(restarting.getSnapshot().session, null);
    assert.equal(restarting.getSnapshot().workflow, null);
  } finally {
    if (originalLocation) Object.defineProperty(globalThis, "location", originalLocation);
    else Reflect.deleteProperty(globalThis, "location");
  }
}

{
  let resolveReady!: (value: ServiceWorkerRegistration) => void;
  const ready = new Promise<ServiceWorkerRegistration>((resolve) => { resolveReady = resolve; });
  let added = 0;
  let removed = 0;
  const registration = {} as ServiceWorkerRegistration;
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      serviceWorker: {
        addEventListener() { added += 1; },
        removeEventListener() { removed += 1; },
        register: async () => registration,
        ready
      }
    }
  });
  try {
    const deferredPreview = createPreviewWorkflowController();
    deferredPreview.loadViteReactTemplate();
    const pendingPreview = deferredPreview.runPreview();
    await Promise.resolve();
    await Promise.resolve();
    deferredPreview.dispose();
    resolveReady(registration);
    await assert.rejects(pendingPreview, /operation cancelled/u);
    assert.equal(added, 0, "disposed operation must not bind a late Service Worker listener");
    assert.equal(removed, 0);
    assert.equal(deferredPreview.getSnapshot().session, null);
    assert.equal(deferredPreview.getSnapshot().workflow, null);
  } finally {
    if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator);
    else Reflect.deleteProperty(globalThis, "navigator");
  }
}

console.log("preview controller dispose test ok");
