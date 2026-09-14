import assert from "node:assert/strict";

import { createMemoryOpfs, createSnapshotStore, createStorageLease, HostProcessTable } from "../../packages/browser-host/src/index.ts";

const opfs = createMemoryOpfs();
const store = createSnapshotStore({
  opfs,
  lease: createStorageLease(),
  root: "recoverable"
});
store.acquireWriter("writer");
const first = { version: 1, files: { "/workspace/a.txt": "one" } };
const second = { version: 1, files: { "/workspace/a.txt": "two" } };
store.save(first, { owner: "writer" });
store.save(second, { owner: "writer" });
opfs.writeFile("recoverable/2.snapshot", { ...opfs.readFile("recoverable/2.snapshot"), integrity: "bad" });

assert.throws(
  () => store.loadLatest(),
  (error) => error.code === "EINTEGRITY"
);
assert.deepEqual(store.recoverLatest(), first);
assert.deepEqual(store.loadLatest(), first);

opfs.writeFile("recoverable/3.tmp", { snapshot: { incomplete: true } });
assert.deepEqual(store.recoverLatest(), first);

class FailingWorker {
  constructor(mode) {
    this.mode = mode;
    this.listeners = new Map();
    this.terminated = false;
  }

  addEventListener(type, listener) {
    this.listeners.set(type, [...(this.listeners.get(type) || []), listener]);
  }

  removeEventListener(type, listener) {
    this.listeners.set(type, (this.listeners.get(type) || []).filter((item) => item !== listener));
  }

  postMessage() {
    queueMicrotask(() => {
      for (const listener of this.listeners.get("message") || []) {
        listener({ data: { type: "failed", error: "worker failed" } });
      }
    });
  }

  terminate() {
    this.terminated = true;
  }
}

const workers = [];
const table = new HostProcessTable({
  workerFactory() {
    const worker = new FailingWorker();
    workers.push(worker);
    return worker;
  }
});
const prepared = table.prepare({ url: "/workers/process-worker.ts" });
const failed = await table.start(prepared.pid);
assert.equal(failed.status, "failed");
assert.equal(failed.resourcesReleased, true);
table.teardown();
table.teardown();
assert.equal(workers[0].terminated, true);

console.log("browser host recovery test ok");
