import { createFailedMessage, createReadyMessage } from "../packages/protocol/src/messages.ts";
import { OPCODES } from "../packages/protocol/src/generated.ts";
import { requestSync } from "../packages/protocol/src/sync-client.ts";
import { runNodeProgram } from "../packages/node-runtime/src/bootstrap.ts";
import { createCliEvaluationHttpBridge, evaluateCliModuleWorkerMessage } from "../packages/node-runtime/src/package-managers/cli-evaluator.ts";
import { MemoryPackageManagerWorkspace } from "../packages/node-runtime/src/package-managers/workspace.ts";
import { createProcessWorkerRuntime } from "../packages/browser-host/src/process/worker-runtime.ts";
import { SystemWasmClient } from "../packages/browser-host/src/process/system-wasm-client.ts";
import { SystemWasmVirtualPty } from "../packages/browser-host/src/process/virtual-pty.ts";
import { installWebAssemblyMemoryLimit } from "../packages/browser-host/src/resources/index.ts";

const YARN_BUNDLE_SHA256 = "443ed69e76443b89afddccfc9faec1ff16eb5e500979cc079c696dec4c3d94ee";
const YARN_ENTRY_SHA256 = "148e19db309ec9eaf7720b28df811337906eea8a1758deaa54afee60a6305e04";
const YARN_FACTORY_SHA256 = "e6f01b28a30aae3d6bd6cf78302d0b1ba1f5e6e8d2f6f918989b6cd7f2a428a0";
const NEXT_ENTRY_SHA256 = "a18774eab8037f10a2ab76c233a225c4a76dbcdc0e59c216508fd0888fa42b03";
const NEXT_FACTORY_SHA256 = "0c103d7af3c610283437fd6f326f5b6b9aa8aa53880926a7e509d2433c515224";
const VITE_FACTORY_SHA256 = "a349825dafc4ab5b2ad3a9fa4489965bda62cb8f47bc5a9fa84f200ea1bfa2aa";
const ROLLDOWN_WASI_BINDING_SHA256 = "b1a16143d4991cc6f4ff6a3043d40a2b757d74746ebe408298b1a2d4b5cb0606";
const ROLLDOWN_WASI_MODULE_SHA256 = "ce4821fa65dcc84f641980889d175fecbdf9fc108ed438c5ab363802a681fce1";
const ROLLDOWN_WASI_WORKER_PATH = "assets/wasi-worker-browser-IL7bwx-u.js";
const ROLLDOWN_WASI_WORKER_SHA256 = "cca841fe347316a6512d885211fc9604d819a06082a4c3eb710e0673cb5a1983";
const BUNDLER_ASSETS = Object.freeze({
  webpack: {
    version: "5.111.0",
    factorySha256: "ffe5da97377b1679e71f1c5087bac1e2ce221a9befd4bbe8fd0e70f2fa29a69d",
    workspaceSha256: "7e2a5bc5ffc0a89711509d8c63f19eb1fea287095a0f9a028302b60c6141d0ec"
  },
  rspack: {
    version: "2.2.4",
    factorySha256: "79e720c3e30ab37d79ee861babf954f827c1e8958f097d07b414c62ea849f730",
    workspaceSha256: "dde01ba66a703c2ac0186412fddcf3bf004a599824fd3edc96dcef5743e25823",
    bindingSha256: "a0dbff6f0abde0062a9e44ce366f71b93a307b32f5e4543e9582d5bfd4e5d4e5",
    wasmSha256: "99425ddaffe461d35421208867c36c7b1edf2166c293a6425f3dc7f653b57055",
    workerSha256: "32c8dd24f1bb60f9f258c450810a5382d7919e3de315b63f924b7cc38518290b"
  }
});

const wasmMemoryPolicy = installWebAssemblyMemoryLimit();

let systemPort = null;
let syncChannel = null;
let nextRequestId = 1;
const cliHttpBridges = new Map();
const cliBundlerInvalidators = new Map();
const cliWasiFileWriters = new Map();
const cliWebSockets = new Map();
const pendingSystemMessages = [];
let systemWasm = null;
let systemWasmError = null;
let systemWasmLoading = false;

function loadSystemWasm(url) {
  if (systemWasmLoading) return;
  systemWasmLoading = true;
  void SystemWasmClient.load(new URL(url || "/runtime/system_wasm.wasm", self.location.origin))
  .then((client) => {
    systemWasm = client;
    for (const message of pendingSystemMessages.splice(0)) handleWorkerMessage(message);
  })
  .catch((error) => {
    systemWasmError = error instanceof Error ? error : new Error(String(error));
    for (const message of pendingSystemMessages.splice(0)) {
      postSystemWasmFailure(message, systemWasmError);
    }
  });
}
const processRuntime = createProcessWorkerRuntime({
  createVirtualPty(mode, size) {
    if (!systemWasm) throw new Error("system WASM is not ready");
    return new SystemWasmVirtualPty(systemWasm, mode, size);
  },
  postMessage(message) {
    self.postMessage(message);
  }
});

self.addEventListener("message", (event) => {
  if (systemWasmError) {
    postSystemWasmFailure(event.data, systemWasmError);
    return;
  }
  if (!systemWasm) {
    pendingSystemMessages.push(event.data);
    // Legacy and direct CLI consumers may not send an explicit initialization
    // message. The content-addressed production fallback is therefore loaded
    // on the first queued message, while explicit producers can still override
    // it with systemWasmUrl.
    loadSystemWasm(event.data?.systemWasmUrl);
    return;
  }
  handleWorkerMessage(event.data);
});

function postSystemWasmFailure(message, error) {
  self.postMessage({
    type: "failed",
    pid: message?.pid,
    generation: message?.generation,
    error: error.message
  });
}

function handleWorkerMessage(message) {
  if (processRuntime.handleMessage(message)) {
    return;
  } else if (message?.type === "boot") {
    try {
      if (message.fail) throw new Error("forced process boot failure");
      systemPort = message.port;
      if (!systemPort) throw new Error("missing system message port");
      syncChannel = message.syncChannel;
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
        sharedArrayBuffer: typeof SharedArrayBuffer,
        webAssemblyMemoryLimitBytes: wasmMemoryPolicy.limitBytes,
        webAssemblyMaximumPages: wasmMemoryPolicy.maximumPages
      }));
    } catch (error) {
      self.postMessage(createFailedMessage("process", error));
    }
  } else if (message?.type === "initialize-runtime") {
    self.postMessage({ type: "runtime-initialized" });
  } else if (message?.type === "run") {
    runProgram(message);
  } else if (message?.type === "resource-policy-probe") {
    probeResourcePolicy(message);
  } else if (message?.type === "cli:evaluate") {
    evaluateCli(message);
  } else if (message?.type === "cli:http:request") {
    handleCliHttpRequest(message);
  } else if (message?.type === "cli:fs:write") {
    handleCliFsWrite(message);
  } else if (message?.type === "cli:ws:connect") {
    handleCliWebSocketConnect(message);
  } else if (message?.type === "cli:ws:message") {
    handleCliWebSocketMessage(message);
  } else if (message?.type === "cli:ws:close") {
    handleCliWebSocketClose(message);
  }
}

function probeResourcePolicy(message) {
  let oversizeRejected = false;
  try {
    new WebAssembly.Memory({ initial: 1, maximum: wasmMemoryPolicy.maximumPages + 1 });
  } catch {
    oversizeRejected = true;
  }
  const bounded = new WebAssembly.Memory({ initial: 1, maximum: 2 });
  self.postMessage({
    type: "resource-policy-result",
    requestId: message.requestId,
    limitBytes: wasmMemoryPolicy.limitBytes,
    maximumPages: wasmMemoryPolicy.maximumPages,
    boundedMemoryBytes: bounded.buffer.byteLength,
    oversizeRejected
  });
}

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
  cliBundlerInvalidators.delete(message.id);
  cliWasiFileWriters.delete(message.id);
  try {
    const pinnedRuntime = message.request?.entry?.name === "yarn"
      ? { precompiledCjsFactories: await loadPinnedYarnFactories(message) }
      : message.request?.entry?.name === "next"
        ? await loadPinnedNextFactories(message)
      : isPinnedViteEntrypoint(message.request?.entry)
        ? await loadPinnedViteFactories(message)
      : isPinnedBundlerEntrypoint(message.request?.entry)
        ? await loadPinnedBundlerFactories(message)
        : {};
    const { invalidateBundler, readRolldownWasiDirectory, readRspackWasiDirectory, writeRspackWasiFile, ...pinnedFactories } = pinnedRuntime;
    if (invalidateBundler) cliBundlerInvalidators.set(message.id, invalidateBundler);
    if (writeRspackWasiFile) cliWasiFileWriters.set(message.id, writeRspackWasiFile);
    const httpBridge = message.bridgeLoopbackServer ? createCliEvaluationHttpBridge() : null;
    response = await evaluateCliModuleWorkerMessage(message, {
      ...(httpBridge ? { httpBridge } : {}),
      ...pinnedFactories,
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
    if (readRolldownWasiDirectory && response.result?.workspaceSnapshot) {
      const workspace = MemoryPackageManagerWorkspace.fromSnapshot(response.result.workspaceSnapshot);
      for (const file of readRolldownWasiDirectory(message.request.cwd)) workspace.writeBytes(file.path, file.data);
      response.result.workspaceSnapshot = workspace.snapshot();
    }
    if (readRspackWasiDirectory && response.result?.workspaceSnapshot) {
      const workspace = MemoryPackageManagerWorkspace.fromSnapshot(response.result.workspaceSnapshot);
      for (const file of readRspackWasiDirectory(message.request.cwd)) workspace.writeBytes(file.path, file.data);
      response.result.workspaceSnapshot = workspace.snapshot();
    }
    if (httpBridge && response.result?.bridgedServerPorts?.length) {
      cliHttpBridges.set(message.id, httpBridge);
      if (message.request?.entry?.name === "next" && message.request?.args?.[0] !== "build") {
        delete response.result.workspaceSnapshot;
      }
    }
  } catch (error) {
    response = { id: message.id, error: error instanceof Error ? error.message : String(error), type: "cli:result" };
  }
  self.postMessage(response);
}

function isPinnedBundlerEntrypoint(entry) {
  return (entry?.name === "webpack" && entry.entry?.endsWith("/node_modules/webpack-cli/bin/cli.js"))
    || (entry?.name === "rspack" && entry.entry?.endsWith("/node_modules/@rspack/cli/bin/rspack.js"));
}

async function loadPinnedBundlerFactories(message) {
  const lane = message.request.entry.name;
  const expected = BUNDLER_ASSETS[lane];
  if (!expected || message.request.entry.version !== expected.version) {
    throw new Error(`ERR_${String(lane).toUpperCase()}_CSP_UNSUPPORTED_VERSION`);
  }
  const assetRoot = new URL(`/vendor/${lane}-${expected.version}/`, self.location.origin);
  const factoryUrl = new URL("cli-static-factories.mjs", assetRoot);
  const workspaceUrl = new URL("package-workspace.bin", assetRoot);
  await verifyStaticAsset(factoryUrl, expected.factorySha256, `ERR_${lane.toUpperCase()}_CSP_FACTORY_INTEGRITY`);
  const workspaceResponse = await fetch(workspaceUrl, { cache: "no-store" });
  const workspaceBytes = new Uint8Array(await workspaceResponse.arrayBuffer());
  if (!workspaceResponse.ok || await sha256(workspaceBytes) !== expected.workspaceSha256) {
    throw new Error(`ERR_${lane.toUpperCase()}_CSP_WORKSPACE_INTEGRITY`);
  }
  if (lane === "rspack") {
    await verifyStaticAsset(new URL("rspack-wasi-binding.mjs", assetRoot), expected.bindingSha256, "ERR_RSPACK_WASI_BINDING_INTEGRITY");
    await verifyStaticAsset(new URL("assets/rspack.wasm", assetRoot), expected.wasmSha256, "ERR_RSPACK_WASI_MODULE_INTEGRITY");
    await verifyStaticAsset(new URL("assets/wasi-worker-browser.mjs", assetRoot), expected.workerSha256, "ERR_RSPACK_WASI_WORKER_INTEGRITY");
    message.request.env = { ...(message.request.env || {}), RSPACK_BINDING: "@rspack/binding-wasm32-wasi" };
  } else {
    message.request.env = {
      ...(message.request.env || {}),
      SKIP_VALIDATION: "y",
      WEBPACK_CLI_SKIP_IMPORT_LOCAL: "1"
    };
  }
  const factories = await import(/* @vite-ignore */ factoryUrl.href);
  if (factories.bundler !== lane || factories.version !== expected.version || factories.snapshotSha256 !== expected.workspaceSha256) {
    throw new Error(`ERR_${lane.toUpperCase()}_CSP_FACTORY_MISMATCH`);
  }
  if (factories.skippedModules?.length !== 0 || typeof factories.cjsFactories !== "object" || typeof factories.esmFactories !== "object") {
    throw new Error(`ERR_${lane.toUpperCase()}_CSP_FACTORY_EXPORTS`);
  }
  if (typeof factories.invalidateBundler !== "function") throw new Error(`ERR_${lane.toUpperCase()}_CSP_FACTORY_EXPORTS`);
  const packageSnapshot = JSON.parse(await gunzipUtf8(workspaceBytes));
  const workspace = MemoryPackageManagerWorkspace.fromSnapshot(message.workspaceSnapshot);
  for (const directory of packageSnapshot.directories) workspace.mkdir(directory);
  for (const file of packageSnapshot.files) workspace.writeBytes(file.path, decodeBase64(file.data));
  for (const [path, expectedHash] of Object.entries(factories.sourceSha256 || {})) {
    if (await sha256(workspace.readBytes(path)) !== expectedHash) throw new Error(`ERR_${lane.toUpperCase()}_CSP_SOURCE_INTEGRITY: ${path}`);
  }
  message.workspaceSnapshot = workspace.snapshot();
  if (lane === "rspack") {
    if (typeof factories.mountWorkspaceIntoRspackWasi !== "function"
      || typeof factories.readRspackWasiDirectory !== "function"
      || typeof factories.writeRspackWasiFile !== "function") {
      throw new Error("ERR_RSPACK_WASI_FS_BRIDGE");
    }
    factories.mountWorkspaceIntoRspackWasi(message.workspaceSnapshot);
  }
  return {
    precompiledCjsFactories: factories.cjsFactories,
    precompiledEsmFactories: factories.esmFactories,
    invalidateBundler: factories.invalidateBundler,
    ...(lane === "rspack" ? {
      readRspackWasiDirectory: factories.readRspackWasiDirectory,
      writeRspackWasiFile: factories.writeRspackWasiFile
    } : {})
  };
}

async function gunzipUtf8(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new TextDecoder().decode(await new Response(stream).arrayBuffer());
}

function decodeBase64(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function loadPinnedNextFactories(message) {
  if (message.request.entry.version !== "15.5.26") throw new Error("ERR_NEXT_CSP_UNSUPPORTED_VERSION");
  const entry = message.request.entry.entry;
  if (!entry.endsWith("/dist/bin/next")) throw new Error("ERR_NEXT_CSP_UNEXPECTED_ENTRY");
  const workspace = MemoryPackageManagerWorkspace.fromSnapshot(message.workspaceSnapshot);
  if (await sha256(workspace.readBytes(entry)) !== NEXT_ENTRY_SHA256) {
    throw new Error("ERR_NEXT_CSP_ENTRY_INTEGRITY");
  }
  const factoryUrl = new URL("../vendor/next-cli-15.5.26.mjs", self.location.href);
  const factoryResponse = await fetch(factoryUrl, { cache: "no-store" });
  if (!factoryResponse.ok || await sha256(new Uint8Array(await factoryResponse.arrayBuffer())) !== NEXT_FACTORY_SHA256) {
    throw new Error("ERR_NEXT_CSP_FACTORY_INTEGRITY");
  }
  const factories = await import(/* @vite-ignore */ factoryUrl.href);
  if (factories.nextVersion !== "15.5.26" || typeof factories.sourceSha256 !== "object" ||
      typeof factories.cjsFactories !== "object" || typeof factories.esmFactories !== "object") {
    throw new Error("ERR_NEXT_CSP_FACTORY_MISMATCH");
  }
  for (const [path, expected] of Object.entries(factories.sourceSha256)) {
    const actual = await sha256(workspace.readBytes(path));
    if (actual !== expected) throw new Error(`ERR_NEXT_CSP_SOURCE_INTEGRITY: ${path} expected=${expected} actual=${actual}`);
  }
  return {
    precompiledCjsFactories: factories.cjsFactories,
    precompiledEsmFactories: factories.esmFactories
  };
}

function isPinnedViteEntrypoint(entry) {
  return entry?.name === "vite" && entry.entry?.endsWith("/node_modules/vite/bin/vite.js");
}

async function loadPinnedViteFactories(message) {
  if (message.request.entry.version !== "8.2.0") throw new Error("ERR_VITE_CSP_UNSUPPORTED_VERSION");
  const entry = message.request.entry.entry;
  if (!entry.endsWith("/node_modules/vite/bin/vite.js")) throw new Error("ERR_VITE_CSP_UNEXPECTED_ENTRY");
  const assetRoot = new URL("../vendor/vite-8.2.0/", self.location.href);
  await verifyStaticAsset(new URL("vite-cli-static-factories.mjs", assetRoot), VITE_FACTORY_SHA256, "ERR_VITE_CSP_FACTORY_INTEGRITY");
  await verifyStaticAsset(new URL("rolldown-wasi-binding.mjs", assetRoot), ROLLDOWN_WASI_BINDING_SHA256, "ERR_ROLLDOWN_WASI_BINDING_INTEGRITY");
  await verifyStaticAsset(new URL("assets/rolldown-binding.wasm", assetRoot), ROLLDOWN_WASI_MODULE_SHA256, "ERR_ROLLDOWN_WASI_MODULE_INTEGRITY");
  await verifyStaticAsset(new URL(ROLLDOWN_WASI_WORKER_PATH, assetRoot), ROLLDOWN_WASI_WORKER_SHA256, "ERR_ROLLDOWN_WASI_WORKER_INTEGRITY");
  const factories = await import(/* @vite-ignore */ new URL("vite-cli-static-factories.mjs", assetRoot).href);
  if (factories.fixtureRevision !== "1544bb1b7ac92f775e9d0dea97954c99cc6cbd43" || factories.viteVersion !== "8.2.0" || factories.rolldownVersion !== "1.2.8") {
    throw new Error("ERR_VITE_CSP_FACTORY_MISMATCH");
  }
  const workspace = MemoryPackageManagerWorkspace.fromSnapshot(message.workspaceSnapshot);
  for (const [path, expected] of Object.entries(factories.sourceSha256 || {})) {
    if (await sha256(workspace.readBytes(path)) !== expected) throw new Error(`ERR_VITE_CSP_SOURCE_INTEGRITY: ${path}`);
  }
  if (typeof factories.cjsFactories !== "object" || typeof factories.esmFactories !== "object") {
    throw new Error("ERR_VITE_CSP_FACTORY_EXPORTS");
  }
  if (typeof factories.mountWorkspaceIntoRolldownWasi !== "function" || typeof factories.readRolldownWasiDirectory !== "function") {
    throw new Error("ERR_ROLLDOWN_WASI_FS_BRIDGE");
  }
  factories.mountWorkspaceIntoRolldownWasi(message.workspaceSnapshot);
  return {
    precompiledCjsFactories: factories.cjsFactories,
    precompiledEsmFactories: factories.esmFactories,
    readRolldownWasiDirectory: factories.readRolldownWasiDirectory
  };
}

async function verifyStaticAsset(url, expectedSha256, code) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok || await sha256(new Uint8Array(await response.arrayBuffer())) !== expectedSha256) {
    throw new Error(code);
  }
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
    const response = await bridge.handleRequest(message.port, message.request);
    self.postMessage({
      evaluationId: message.evaluationId,
      id: message.id,
      ...(bridge.getOutput ? { output: bridge.getOutput() } : {}),
      response,
      type: "cli:http:response"
    });
  } catch (error) {
    self.postMessage({
      error: error instanceof Error ? error.stack || error.message : String(error),
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
    cliWasiFileWriters.get(message.evaluationId)?.(message.path, message.data);
    const result = bridge.writeFile(message.path, message.data);
    cliBundlerInvalidators.get(message.evaluationId)?.(message.path);
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
