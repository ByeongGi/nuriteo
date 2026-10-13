import assert from "node:assert/strict";

import {
  createHostProcessShellCommand,
  HostProcessTable
} from "../../browser-host/src/index.ts";
import { createTerminalSession } from "../../node-runtime/src/index.ts";

class TerminalWorker {
  constructor() {
    this.listeners = new Map();
    this.messages = [];
    this.terminated = false;
  }

  addEventListener(type, listener) {
    this.listeners.set(type, [...(this.listeners.get(type) || []), listener]);
  }

  removeEventListener(type, listener) {
    this.listeners.set(type, (this.listeners.get(type) || []).filter((item) => item !== listener));
  }

  postMessage(message) {
    this.messages.push(message);
    if (message.type === "start") {
      queueMicrotask(() => {
        this.emit("message", { data: { type: "ready" } });
        this.emit("message", { data: { type: "stdout", data: "vite dev server ready\n" } });
      });
      return;
    }
    if (message.type === "stdin" && message.data === "q\n") {
      this.emit("message", { data: { type: "stderr", data: "stopping\n" } });
      this.emit("message", { data: { type: "exit", code: 0 } });
    }
  }

  terminate() {
    this.terminated = true;
  }

  emit(type, event) {
    for (const listener of this.listeners.get(type) || []) listener(event);
  }
}

const workers = [];
const table = new HostProcessTable({
  signalGraceMs: 0,
  workerFactory() {
    const worker = new TerminalWorker();
    workers.push(worker);
    return worker;
  }
});
const chunks = [];
const terminal = createTerminalSession({
  commands: {
    vite: createHostProcessShellCommand({
      table,
      url: "/workers/vite-process.js"
    })
  },
  onChunk(chunk) {
    chunks.push(chunk);
  }
});

const run = terminal.run("vite dev");
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(terminal.activeEntry.command, "vite dev");
assert.equal(chunks[0].data, "vite dev server ready\n");
const [processOutput] = table.output(1);
assert.equal(processOutput.data, "vite dev server ready\n");
assert.equal(table.writeStdin(1, "q\n"), true);
const result = await run;

assert.equal(result.exitCode, 0);
assert.equal(result.stdout, "vite dev server ready\n");
assert.equal(result.stderr, "stopping\n");
assert.equal(result.entry.status, "completed");
assert.deepEqual(chunks.map((chunk) => `${chunk.stream}:${chunk.data.trim()}`), [
  "stdout:vite dev server ready",
  "stderr:stopping"
]);
assert.equal(workers[0].terminated, true);
assert.equal(workers[0].messages.some((message) => message.type === "stdin" && message.data === "q\n"), true);

const cancelWorkers = [];
const cancelTable = new HostProcessTable({
  signalGraceMs: 0,
  workerFactory() {
    const worker = new TerminalWorker();
    cancelWorkers.push(worker);
    return worker;
  }
});
const cancellableTerminal = createTerminalSession({
  commands: {
    vite: createHostProcessShellCommand({
      table: cancelTable,
      url: "/workers/vite-process.js"
    })
  }
});
const cancellableRun = cancellableTerminal.run("vite dev");
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(cancellableTerminal.cancel(), true);
const cancelled = await cancellableRun;
assert.equal(cancelled.entry.status, "cancelled");
assert.equal(cancelled.exitCode, 130);
assert.equal(cancelWorkers[0].terminated, true);

const timeoutTable = new HostProcessTable({
  startupTimeoutMs: 0,
  workerFactory() {
    const worker = new TerminalWorker();
    worker.postMessage = function postMessage(message) {
      this.messages.push(message);
    };
    return worker;
  }
});
const timeoutCommand = createHostProcessShellCommand({
  table: timeoutTable,
  url: "/workers/slow-process.js"
});
const timedOut = await timeoutCommand({
  argv: ["slow"],
  cwd: "/workspace",
  env: {},
  stdin: ""
});
assert.equal(timedOut.exitCode, 1);
assert.equal(timedOut.stderr, "startup timeout\n");

console.log("browser host process terminal command test ok");
