import { createFailedMessage, createReadyMessage } from "../packages/protocol/src/messages.ts";
import { OPCODES } from "../packages/protocol/src/generated.ts";
import { requestSync } from "../packages/protocol/src/sync-client.ts";
import { runNodeProgram } from "../packages/node-runtime/src/bootstrap.ts";
import { createCliEvaluationHttpBridge, evaluateCliModuleWorkerMessage } from "../packages/node-runtime/src/package-managers/cli-evaluator.ts";
import { MemoryPackageManagerWorkspace } from "../packages/node-runtime/src/package-managers/workspace.ts";
import { createProcessWorkerRuntime } from "../packages/browser-host/src/process/worker-runtime.ts";

const YARN_BUNDLE_SHA256 = "443ed69e76443b89afddccfc9faec1ff16eb5e500979cc079c696dec4c3d94ee";
const YARN_ENTRY_SHA256 = "148e19db309ec9eaf7720b28df811337906eea8a1758deaa54afee60a6305e04";
const YARN_FACTORY_SHA256 = "e6f01b28a30aae3d6bd6cf78302d0b1ba1f5e6e8d2f6f918989b6cd7f2a428a0";

let systemPort = null;
let syncChannel = null;
let nextRequestId = 1;
const cliHttpBridges = new Map();
const cliWebSockets = new Map();
const processRuntime = createProcessWorkerRuntime({
  postMessage(message) {
    self.postMessage(message);
  }
});

self.addEventListener("message", (event) => {
  if (processRuntime.handleMessage(event.data)) {
    return;
  } else if (event.data?.type === "boot") {
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
  let response;
  try {
    const precompiledCjsFactories = message.request?.entry?.name === "yarn"
      ? await loadPinnedYarnFactories(message)
      : undefined;
    const httpBridge = message.bridgeLoopbackServer ? createCliEvaluationHttpBridge() : null;
    response = await evaluateCliModuleWorkerMessage(message, {
    ...(httpBridge ? { httpBridge } : {}),
    ...(precompiledCjsFactories ? { precompiledCjsFactories } : {}),
    nestedWorkerFactory: (request) => {
      const worker = new Worker(new URL("./cli-nested-worker.ts", import.meta.url), { type: "module" });
      worker.postMessage({ type: "cli:nested:init", request });
      return {
        postMessage: (value) => worker.postMessage(value),
        terminate: () => worker.terminate(),
        onMessage: (listener) => worker.addEventListener("message", (event) => listener(event.data)),
        onError: (listener) => worker.addEventListener("error", (event) => listener(new Error(event.message))),
        onExit: () => {}
      };
    }
    });
    if (httpBridge && response.result?.bridgedServerPorts?.length) cliHttpBridges.set(message.id, httpBridge);
  } catch (error) {
    response = { id: message.id, error: error instanceof Error ? error.message : String(error), type: "cli:result" };
  }
  self.postMessage(response);
}

async function loadPinnedYarnFactories(message) {
  if (message.request.entry.version !== "1.22.22") throw new Error("ERR_YARN_CSP_UNSUPPORTED_VERSION");
  const entry = message.request.entry.entry;
  if (!entry.endsWith("/bin/yarn.js")) throw new Error("ERR_YARN_CSP_UNEXPECTED_ENTRY");
  const bundle = entry.slice(0, -"bin/yarn.js".length) + "lib/cli.js";
  const workspace = MemoryPackageManagerWorkspace.fromSnapshot(message.workspaceSnapshot);
  if (await sha256(workspace.readBytes(entry)) !== YARN_ENTRY_SHA256 ||
      await sha256(workspace.readBytes(bundle)) !== YARN_BUNDLE_SHA256) {
    throw new Error("ERR_YARN_CSP_BUNDLE_INTEGRITY");
  }
  const factoryUrl = new URL("../vendor/yarn-cli-1.22.22.mjs", self.location.href);
  const factoryResponse = await fetch(factoryUrl, { cache: "no-store" });
  if (!factoryResponse.ok || await sha256(new Uint8Array(await factoryResponse.arrayBuffer())) !== YARN_FACTORY_SHA256) {
    throw new Error("ERR_YARN_CSP_FACTORY_INTEGRITY");
  }
  const { sourceSha256, evaluateYarnCjs } = await import(/* @vite-ignore */ factoryUrl.href);
  if (sourceSha256 !== YARN_BUNDLE_SHA256 || typeof evaluateYarnCjs !== "function") {
    throw new Error("ERR_YARN_CSP_FACTORY_MISMATCH");
  }
  return {
    [bundle]: evaluateYarnCjs,
    [entry]: (context, globals) => {
      const cli = context.require(bundle);
      if (!cli.autoRun) Promise.resolve(cli.default()).catch((error) => {
        globals.console.error(error?.stack || error?.message || error);
        globals.process.exitCode = 1;
      });
    }
  };
}

async function sha256(bytes) {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (byte) => byte.toString(16).padStart(2, "0")).join("");
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
