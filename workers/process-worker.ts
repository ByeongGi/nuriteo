import { createFailedMessage, createReadyMessage } from "../packages/protocol/src/messages.ts";
import { OPCODES } from "../packages/protocol/src/generated.ts";
import { requestSync } from "../packages/protocol/src/sync-client.ts";
import { runNodeProgram } from "../packages/node-runtime/src/bootstrap.ts";
import { evaluateCliModuleWorkerMessage } from "../packages/node-runtime/src/package-managers/cli-evaluator.ts";

let systemPort = null;
let syncChannel = null;
let nextRequestId = 1;

self.addEventListener("message", (event) => {
  if (event.data?.type === "boot") {
    try {
      if (event.data.fail) throw new Error("forced process boot failure");
      systemPort = event.data.port;
      if (!systemPort) throw new Error("missing system message port");
      syncChannel = event.data.syncChannel;
      systemPort.start();
      systemPort.onmessage = (portEvent) => {
        if (portEvent.data?.type === "ping") {
          systemPort.postMessage({ type: "pong", from: "process" });
        } else if (portEvent.data?.type === "run-syscall-ping") {
          runSyscallPing(portEvent.data).catch((error) => {
            systemPort.postMessage({
              type: "syscall-result",
              ok: false,
              error: error.message
            });
          });
        }
      };
      self.postMessage(createReadyMessage("process", {
        crossOriginIsolated: self.crossOriginIsolated,
        sharedArrayBuffer: typeof SharedArrayBuffer
      }));
    } catch (error) {
      self.postMessage(createFailedMessage("process", error));
    }
  } else if (event.data?.type === "run") {
    runProgram(event.data);
  } else if (event.data?.type === "cli:evaluate") {
    evaluateCli(event.data);
  }
});

async function runSyscallPing(message) {
  if (!syncChannel) throw new Error("missing sync channel");
  const response = requestSync(syncChannel, {
    requestId: nextRequestId++,
    generation: message.generation,
    pid: 1,
    opcode: OPCODES.ping,
    payload: "ping"
  });
  systemPort.postMessage({
    type: "syscall-result",
    ok: true,
    opcode: response.opcode,
    status: response.status,
    payload: new TextDecoder().decode(response.payload)
  });
}

function runProgram(message) {
  try {
    const output = runNodeProgram(message.source, {
      syncChannel,
      entrypoint: message.entrypoint,
      generation: message.generation,
      pid: message.pid,
      timeoutMs: message.timeoutMs
    });
    self.postMessage({
      type: "run-result",
      ok: true,
      exports: output.exports,
      result: output.result
    });
  } catch (error) {
    self.postMessage({
      type: "run-result",
      ok: false,
      error: error.message
    });
  }
}

async function evaluateCli(message) {
  self.postMessage(await evaluateCliModuleWorkerMessage(message));
}
