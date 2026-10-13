import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";

import { encodeRequest } from "../src/codec.ts";
import { ERROR_CODES, OPCODES } from "../src/generated.ts";
import {
  createSyncChannel,
  openSyncChannel,
  requestSync,
  SyncChannelError,
  SYNC_STATE
} from "../src/sync-client.ts";
import type { DecodedFrame, ErrorCode } from "../src/types.ts";

const syncClientUrl = new URL("../src/sync-client.ts", import.meta.url).href;

type ServerMode = "normal" | "stale" | "terminal" | "failed";

type WorkerResult =
  | { ok: true }
  | { ok: false; name: string; code?: ErrorCode; message: string };

function spawnServer(mode: ServerMode, channel: SharedArrayBuffer): Worker {
  const source = `
    import { parentPort, workerData } from "node:worker_threads";
    import { waitForRequest, respondSync, failSync, markTerminal } from ${JSON.stringify(syncClientUrl)};

    try {
      const request = waitForRequest(workerData.channel, { timeoutMs: 1000 });
      if (workerData.mode === "stale") {
        respondSync(workerData.channel, { ...request, generation: request.generation + 1 }, "stale");
      } else if (workerData.mode === "terminal") {
        markTerminal(workerData.channel);
      } else if (workerData.mode === "failed") {
        failSync(workerData.channel, 74);
      } else {
        respondSync(workerData.channel, request, "pong");
      }
      parentPort.postMessage({ ok: true });
    } catch (error) {
      parentPort.postMessage({
        ok: false,
        name: error.name,
        code: error.code,
        message: error.message
      });
    }
  `;
  return new Worker(new URL(`data:text/javascript,${encodeURIComponent(source)}`), {
    workerData: { mode, channel }
  });
}

function waitForWorker(worker: Worker): Promise<WorkerResult> {
  return new Promise((resolve, reject) => {
    worker.once("message", resolve);
    worker.once("error", reject);
  });
}

function assertSyncError(fn: () => unknown, code: ErrorCode): void {
  assert.throws(
    fn,
    (error) => error instanceof SyncChannelError && error.code === code,
    `expected SyncChannelError ${code}`
  );
}

async function withServer<T>(
  mode: ServerMode,
  callback: (channel: SharedArrayBuffer) => T
): Promise<{ result: T; serverResult: WorkerResult }> {
  const channel = createSyncChannel(4096);
  const worker = spawnServer(mode, channel);
  try {
    const result = callback(channel);
    const serverResult = await waitForWorker(worker);
    return { result, serverResult };
  } finally {
    await worker.terminate();
  }
}

const normal = await withServer<DecodedFrame>("normal", (channel) => requestSync(channel, {
  requestId: 1,
  generation: 7,
  pid: 3,
  opcode: OPCODES.ping,
  payload: "ping"
}));
assert.equal(new TextDecoder().decode(normal.result.payload), "pong");
assert.equal(normal.serverResult.ok, true);

const stale = await withServer("stale", (channel) => {
  assertSyncError(() => requestSync(channel, {
    requestId: 2,
    generation: 7,
    pid: 3,
    opcode: OPCODES.ping,
    payload: "ping"
  }), ERROR_CODES.EBADMSG);
});
assert.equal(stale.serverResult.ok, true);

const terminal = await withServer("terminal", (channel) => {
  assertSyncError(() => requestSync(channel, {
    requestId: 3,
    generation: 8,
    pid: 3,
    opcode: OPCODES.ping,
    payload: "ping"
  }), ERROR_CODES.EBADMSG);
});
assert.equal(terminal.serverResult.ok, true);

const failed = await withServer("failed", (channel) => {
  assertSyncError(() => requestSync(channel, {
    requestId: 4,
    generation: 9,
    pid: 3,
    opcode: OPCODES.ping,
    payload: "ping"
  }), ERROR_CODES.EBADMSG);
});
assert.equal(failed.serverResult.ok, true);

const malformedChannel = createSyncChannel(4096);
const malformedWorker = spawnServer("normal", malformedChannel);
const opened = openSyncChannel(malformedChannel);
const frame = encodeRequest({
  requestId: 5,
  generation: 10,
  pid: 3,
  opcode: OPCODES.ping,
  payload: "ping"
});
opened.data.set(frame.slice(0, -1));
Atomics.store(opened.control, 1, frame.byteLength - 1);
Atomics.store(opened.control, 3, 10);
Atomics.store(opened.control, 0, SYNC_STATE.request);
Atomics.notify(opened.control, 0);
const malformedResult = await waitForWorker(malformedWorker);
await malformedWorker.terminate();
assert.equal(malformedResult.ok, false);
assert.equal(Atomics.load(opened.control, 0), SYNC_STATE.failed);

const publishingChannel = createSyncChannel(4096);
const publishingOpened = openSyncChannel(publishingChannel);
Atomics.store(publishingOpened.control, 0, SYNC_STATE.writing);
const publishingWorker = spawnServer("normal", publishingChannel);
await new Promise((resolve) => setTimeout(resolve, 20));
const publishingFrame = encodeRequest({
  requestId: 6,
  generation: 11,
  pid: 3,
  opcode: OPCODES.ping,
  payload: "ping"
});
publishingOpened.data.set(publishingFrame);
Atomics.store(publishingOpened.control, 1, publishingFrame.byteLength);
Atomics.store(publishingOpened.control, 3, 11);
Atomics.store(publishingOpened.control, 0, SYNC_STATE.request);
Atomics.notify(publishingOpened.control, 0);
const publishingResult = await waitForWorker(publishingWorker);
await publishingWorker.terminate();
assert.equal(publishingResult.ok, true);
assert.equal(Atomics.load(publishingOpened.control, 0), SYNC_STATE.response);

const smallChannel = createSyncChannel(64);
assertSyncError(() => requestSync(smallChannel, {
  requestId: 7,
  generation: 12,
  pid: 3,
  opcode: OPCODES.ping,
  payload: new Uint8Array(128)
}), ERROR_CODES.E2BIG);

console.log("sync client test ok");
