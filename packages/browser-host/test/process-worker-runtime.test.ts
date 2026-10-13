import assert from "node:assert/strict";

import { createProcessWorkerRuntime } from "../../browser-host/src/process/worker-runtime.ts";

const messages: Array<Record<string, unknown>> = [];
const runtime = createProcessWorkerRuntime({
  postMessage(message) {
    messages.push(message as Record<string, unknown>);
  }
});

assert.equal(runtime.handleMessage({
  type: "start",
  pid: 7,
  generation: 3,
  argv: ["cat"],
  cwd: "/workspace",
  env: {},
  terminalMode: { canonical: true, echo: true, signals: true },
  terminal: { cols: 80, rows: 24 },
  outputWindowBytes: 1024,
  stdinWindowBytes: 1024
}), true);
await drainMicrotasks();
assert.equal(messages[0]?.type, "ready");

runtime.handleMessage({ type: "stdin", pid: 7, generation: 3, data: "abc", bytes: 3 });
await drainMicrotasks();
assert.equal(stdout(), "abc", "canonical input must echo but remain buffered before newline");

const edited = "\x7fZ\r";
runtime.handleMessage({ type: "stdin", pid: 7, generation: 3, data: edited, bytes: new TextEncoder().encode(edited).byteLength });
await drainMicrotasks();
assert.equal(stdout(), "abc\b \bZ\nabZ\n", "erase and carriage return must follow canonical line discipline");

runtime.handleMessage({ type: "stdin", pid: 7, generation: 3, data: "\x03", bytes: 1 });
await drainMicrotasks();
assert.ok(stdout().endsWith("^C\n"), "Ctrl-C must be echoed using terminal notation");
assert.deepEqual(messages.findLast((message) => message.type === "exit"), {
  type: "exit",
  pid: 7,
  generation: 3,
  code: 130
});

console.log("browser process worker PTY line discipline test ok");

function stdout(): string {
  return messages
    .filter((message) => message.type === "stdout")
    .map((message) => String(message.data || ""))
    .join("");
}

async function drainMicrotasks(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}
