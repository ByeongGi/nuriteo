import assert from "node:assert/strict";

import { HostProcessTable } from "../../packages/browser-host/src/process/index.ts";

class MockWorker {
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

  postMessage(message) {
    this.messages = [...(this.messages || []), message];
    this.startedWith = message;
    if (message.type === "stdin") {
      this.stdin = `${this.stdin || ""}${message.data}`;
      return;
    }
    if (this.mode === "hang") return;
    queueMicrotask(() => {
      if (this.mode === "ready") this.emit("message", { data: { type: "ready" } });
      if (this.mode === "failed") this.emit("message", { data: { type: "failed", error: "boom" } });
      if (this.mode === "exit") this.emit("message", { data: { type: "exit", code: 9 } });
    });
  }

  terminate() {
    this.terminated = true;
  }

  emit(type, event) {
    for (const listener of this.listeners.get(type) || []) listener(event);
  }
}

function createTable(mode) {
  const workers = [];
  const output = [];
  const table = new HostProcessTable({
    now: () => 1234,
    onOutput: (chunk) => output.push(chunk),
    workerFactory() {
      const worker = new MockWorker(mode);
      workers.push(worker);
      return worker;
    }
  });
  return { output, table, workers };
}

const readyCase = createTable("ready");
const prepared = readyCase.table.prepare({
  parent: 99,
  cwd: "/workspace/app",
  env: { NODE_ENV: "test" },
  url: "/workers/process-worker.ts"
});
assert.equal(prepared.status, "prepared");
assert.equal(prepared.pid, 1);
assert.equal(prepared.generation, 1);
const ready = await readyCase.table.start(prepared.pid);
assert.equal(ready.status, "ready");
assert.equal(ready.parent, 99);
assert.equal(ready.cwd, "/workspace/app");
assert.equal(ready.env.NODE_ENV, "test");
readyCase.workers[0].emit("message", { data: { type: "stdout", data: "hello\n" } });
readyCase.workers[0].emit("message", { data: { type: "stderr", data: "warn\n" } });
assert.deepEqual(readyCase.output.map((chunk) => `${chunk.stream}:${chunk.data.trim()}`), ["stdout:hello", "stderr:warn"]);
assert.deepEqual(readyCase.table.output(prepared.pid).map((chunk) => chunk.at), [1234, 1234]);
assert.equal(readyCase.table.writeStdin(prepared.pid, "yes\n"), true);
assert.equal(readyCase.workers[0].stdin, "yes\n");
const exited = readyCase.table.stop(prepared.pid, 0);
assert.equal(exited.status, "exited");
assert.equal(exited.stdout, "hello\n");
assert.equal(exited.stderr, "warn\n");
assert.equal(exited.resourcesReleased, true);
assert.equal(readyCase.table.writeStdin(prepared.pid, "late\n"), false);
const duplicateStop = readyCase.table.stop(prepared.pid, 0);
assert.equal(duplicateStop.status, "exited");

const failedCase = createTable("failed");
const failedPrepared = failedCase.table.prepare({ url: "/workers/process-worker.ts" });
const failed = await failedCase.table.start(failedPrepared.pid);
assert.equal(failed.status, "failed");
assert.equal(failed.error, "boom");
assert.equal(failed.resourcesReleased, true);

const waitCase = createTable("hang");
const waitPrepared = waitCase.table.prepare({ url: "/workers/process-worker.ts" });
const startPromise = waitCase.table.start(waitPrepared.pid);
const waitPromise = waitCase.table.wait(waitPrepared.pid);
const killed = waitCase.table.kill(waitPrepared.pid);
const waited = await waitPromise;
const started = await startPromise;
assert.equal(killed.status, "killed");
assert.equal(waited.status, "killed");
assert.equal(started.status, "killed");
assert.equal(waitCase.workers[0].terminated, true);

const replacement = waitCase.table.prepare({ url: "/workers/process-worker.ts" });
assert.notEqual(replacement.pid, waitPrepared.pid);
assert.notEqual(replacement.generation, waitPrepared.generation);

const teardownCase = createTable("hang");
const teardownPrepared = teardownCase.table.prepare({ url: "/workers/process-worker.ts" });
teardownCase.table.start(teardownPrepared.pid);
teardownCase.table.teardown();
const tornDown = await teardownCase.table.wait(teardownPrepared.pid);
assert.equal(tornDown.status, "killed");
assert.equal(teardownCase.workers[0].terminated, true);

console.log("browser host process lifecycle test ok");
