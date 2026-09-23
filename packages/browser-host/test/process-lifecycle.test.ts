import assert from "node:assert/strict";

import { HostProcessTable } from "../../browser-host/src/process/index.ts";

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
assert.equal(readyCase.table.resize(prepared.pid, { cols: 120, rows: 36 }), true);
assert.deepEqual(readyCase.workers[0].messages.at(-1), {
  type: "resize",
  pid: prepared.pid,
  generation: prepared.generation,
  cols: 120,
  rows: 36
});
assert.deepEqual(readyCase.table.list({ activeOnly: true }).map((entry) => entry.pid), [prepared.pid]);
const exited = readyCase.table.stop(prepared.pid, 0);
assert.equal(exited.status, "exited");
assert.equal(exited.stdout, "hello\n");
assert.equal(exited.stderr, "warn\n");
assert.equal(exited.resourcesReleased, true);
assert.equal(readyCase.table.writeStdin(prepared.pid, "late\n"), false);
const duplicateStop = readyCase.table.stop(prepared.pid, 0);
assert.equal(duplicateStop.status, "exited");
assert.deepEqual(readyCase.table.list({ activeOnly: true }), []);

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
const signalStart = waitCase.table.start(replacement.pid);
const interrupted = waitCase.table.signal(replacement.pid, "SIGINT");
assert.equal(interrupted.exitCode, 130);
assert.deepEqual(waitCase.workers.at(-1).messages.at(-1), {
  type: "signal",
  pid: replacement.pid,
  generation: replacement.generation,
  signal: "SIGINT"
});
await signalStart;

const teardownCase = createTable("hang");
const teardownPrepared = teardownCase.table.prepare({ url: "/workers/process-worker.ts" });
teardownCase.table.start(teardownPrepared.pid);
teardownCase.table.teardown();
const tornDown = await teardownCase.table.wait(teardownPrepared.pid);
assert.equal(tornDown.status, "killed");
assert.equal(teardownCase.workers[0].terminated, true);

const churn = createTable("hang");
for (let iteration = 0; iteration < 100; iteration += 1) {
  const process = churn.table.prepare({ url: "/workers/process-worker.ts" });
  const starting = churn.table.start(process.pid);
  const waiting = churn.table.wait(process.pid);
  churn.table.teardown();
  assert.equal((await starting).status, "killed");
  assert.equal((await waiting).resourcesReleased, true);
  assert.equal(churn.table.registry.size(), 0);
  assert.equal(churn.workers.at(-1).listeners.get("message").length, 0);
  assert.equal(churn.workers.at(-1).listeners.get("error").length, 0);
}
assert.equal(churn.workers.filter((worker) => !worker.terminated).length, 0);
const recovered = churn.table.prepare({ url: "/workers/process-worker.ts" });
const recoveredStart = churn.table.start(recovered.pid);
churn.workers.at(-1).emit("message", { data: { type: "ready" } });
assert.equal((await recoveredStart).status, "ready");
churn.table.teardown();
assert.equal(churn.table.registry.size(), 0);

const failedFactory = new HostProcessTable({ workerFactory: () => { throw new Error("allocation failed"); } });
const failedAllocation = failedFactory.prepare({ url: "/workers/process-worker.ts" });
assert.equal((await failedFactory.start(failedAllocation.pid)).status, "failed");
assert.equal((await failedFactory.wait(failedAllocation.pid)).resourcesReleased, true);

const failedPost = new HostProcessTable({ workerFactory: () => ({
  postMessage() { throw new Error("post failed"); },
  terminate() { throw new Error("terminate failed"); }
}) });
const failedSend = failedPost.prepare({ url: "/workers/process-worker.ts" });
assert.equal((await failedPost.start(failedSend.pid)).status, "failed");
assert.equal((await failedPost.wait(failedSend.pid)).resourcesReleased, true);
assert.equal(failedPost.registry.size(), 0);

console.log("browser host process lifecycle test ok");
