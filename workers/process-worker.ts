import { createFailedMessage, createReadyMessage } from "../packages/protocol/src/messages.ts";
import { OPCODES } from "../packages/protocol/src/generated.ts";
import { requestSync } from "../packages/protocol/src/sync-client.ts";
import { runNodeProgram } from "../packages/node-runtime/src/bootstrap.ts";
import { createCliEvaluationHttpBridge, evaluateCliModuleWorkerMessage } from "../packages/node-runtime/src/package-managers/cli-evaluator.ts";

let systemPort = null;
let syncChannel = null;
let nextRequestId = 1;
const cliHttpBridges = new Map();
const cliWebSockets = new Map();

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
  } else if (event.data?.type === "cli:http:request") {
    handleCliHttpRequest(event.data);
  } else if (event.data?.type === "cli:fs:write") {
    handleCliFsWrite(event.data);
  } else if (event.data?.type === "cli:ws:connect") {
    handleCliWebSocketConnect(event.data);
  } else if (event.data?.type === "cli:ws:message") {
    handleCliWebSocketMessage(event.data);
  } else if (event.data?.type === "cli:ws:close") {
    handleCliWebSocketClose(event.data);
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
  const httpBridge = message.bridgeLoopbackServer ? createCliEvaluationHttpBridge() : null;
  const response = await evaluateCliModuleWorkerMessage(message, httpBridge ? { httpBridge } : {});
  if (httpBridge && response.result?.bridgedServerPorts?.length) cliHttpBridges.set(message.id, httpBridge);
  self.postMessage(response);
}

async function handleCliHttpRequest(message) {
  const bridge = cliHttpBridges.get(message.evaluationId);
  if (!bridge) {
    self.postMessage({
      error: `missing CLI HTTP bridge: ${message.evaluationId}`,
      evaluationId: message.evaluationId,
      id: message.id,
      type: "cli:http:response"
    });
    return;
  }
  try {
    self.postMessage({
      evaluationId: message.evaluationId,
      id: message.id,
      response: await bridge.handleRequest(message.port, message.request),
      type: "cli:http:response"
    });
  } catch (error) {
    self.postMessage({
      error: error instanceof Error ? error.message : String(error),
      evaluationId: message.evaluationId,
      id: message.id,
      type: "cli:http:response"
    });
  }
}

async function handleCliFsWrite(message) {
  const bridge = cliHttpBridges.get(message.evaluationId);
  try {
    if (!bridge?.writeFile) throw new Error(`missing CLI fs bridge: ${message.evaluationId}`);
    const result = bridge.writeFile(message.path, message.data);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    self.postMessage({
      evaluationId: message.evaluationId,
      id: message.id,
      result: {
        ...result,
        ...(bridge.getOutput ? { output: bridge.getOutput() } : {})
      },
      type: "cli:fs:write:result"
    });
  } catch (error) {
    self.postMessage({
      error: error instanceof Error ? error.message : String(error),
      evaluationId: message.evaluationId,
      id: message.id,
      type: "cli:fs:write:result"
    });
  }
}

async function handleCliWebSocketConnect(message) {
  const bridge = cliHttpBridges.get(message.evaluationId);
  if (!bridge) {
    self.postMessage({
      error: `missing CLI HTTP bridge: ${message.evaluationId}`,
      evaluationId: message.evaluationId,
      id: message.id,
      type: "cli:ws:error"
    });
    return;
  }
  try {
    const socket = bridge.network.connectWebSocket(`ws://127.0.0.1:${message.port}${message.path}`, {
      headers: message.headers,
      protocol: message.protocol
    });
    cliWebSockets.set(`${message.evaluationId}:${message.id}`, socket);
    socket.onmessage = (event) => {
      self.postMessage({
        data: event.data,
        evaluationId: message.evaluationId,
        id: message.id,
        type: "cli:ws:message"
      });
    };
    socket.onclose = () => {
      cliWebSockets.delete(`${message.evaluationId}:${message.id}`);
      self.postMessage({
        evaluationId: message.evaluationId,
        id: message.id,
        type: "cli:ws:close"
      });
    };
  } catch (error) {
    self.postMessage({
      error: error instanceof Error ? error.message : String(error),
      evaluationId: message.evaluationId,
      id: message.id,
      type: "cli:ws:error"
    });
  }
}

function handleCliWebSocketMessage(message) {
  cliWebSockets.get(`${message.evaluationId}:${message.id}`)?.send(message.data);
}

function handleCliWebSocketClose(message) {
  const key = `${message.evaluationId}:${message.id}`;
  cliWebSockets.get(key)?.close();
  cliWebSockets.delete(key);
}
