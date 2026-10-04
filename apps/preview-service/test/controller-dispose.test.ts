import assert from "node:assert/strict";

import { HostProcessTable } from "../../../packages/browser-host/src/index.ts";
import { createPreviewWorkflowController } from "@nuriteo/preview-service";

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

console.log("preview controller dispose test ok");
