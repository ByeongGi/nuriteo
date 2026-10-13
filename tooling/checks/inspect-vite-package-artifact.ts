#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Worker } from "node:worker_threads";

import {
  createWasmAdapterPolicy,
  createViteDependencyArtifactClosureFromWorkspace,
  createVitePackageArtifactFromWorkspace,
  ViteProductWorkflow
} from "../../packages/node-runtime/src/index.ts";
import { createFallbackWorkspaceReader, createNodeFsWorkspaceReader } from "../shared/fs-workspace-reader.ts";

class NodeThreadCliEvaluationWorker {
  #listeners = {
    message: new Set(),
    error: new Set()
  };
  #worker = new Worker(`
    import { parentPort } from "node:worker_threads";
    import { createCliEvaluationHttpBridge, evaluateCliModuleWorkerMessage } from ${JSON.stringify(new URL("../../packages/node-runtime/src/package-managers/cli-evaluator.ts", import.meta.url).href)};
    const httpBridges = new Map();
    const webSockets = new Map();
    parentPort.on("message", async (message) => {
      try {
        if (message.type === "cli:http:request") {
          const bridge = httpBridges.get(message.evaluationId);
          if (!bridge) throw new Error("missing CLI HTTP bridge: " + message.evaluationId);
          parentPort.postMessage({
            evaluationId: message.evaluationId,
            id: message.id,
            response: await bridge.handleRequest(message.port, message.request),
            type: "cli:http:response"
          });
          return;
        }
        if (message.type === "cli:fs:write") {
          const bridge = httpBridges.get(message.evaluationId);
          try {
            if (!bridge?.writeFile) throw new Error("missing CLI fs bridge: " + message.evaluationId);
            const result = bridge.writeFile(message.path, message.data);
            await new Promise((resolve) => setTimeout(resolve, 1000));
            parentPort.postMessage({
              evaluationId: message.evaluationId,
              id: message.id,
              result: {
                ...result,
                ...(bridge.getOutput ? { output: bridge.getOutput() } : {})
              },
              type: "cli:fs:write:result"
            });
          } catch (error) {
            parentPort.postMessage({
              error: error instanceof Error ? error.message : String(error),
              evaluationId: message.evaluationId,
              id: message.id,
              type: "cli:fs:write:result"
            });
          }
          return;
        }
        if (message.type === "cli:ws:connect") {
          const bridge = httpBridges.get(message.evaluationId);
          if (!bridge) throw new Error("missing CLI HTTP bridge: " + message.evaluationId);
          const socket = bridge.network.connectWebSocket("ws://127.0.0.1:" + message.port + message.path, {
            headers: message.headers,
            protocol: message.protocol
          });
          webSockets.set(message.evaluationId + ":" + message.id, socket);
          socket.onmessage = (event) => parentPort.postMessage({
            data: event.data,
            evaluationId: message.evaluationId,
            id: message.id,
            type: "cli:ws:message"
          });
          socket.onclose = () => {
            webSockets.delete(message.evaluationId + ":" + message.id);
            parentPort.postMessage({
              evaluationId: message.evaluationId,
              id: message.id,
              type: "cli:ws:close"
            });
          };
          return;
        }
        if (message.type === "cli:ws:message") {
          webSockets.get(message.evaluationId + ":" + message.id)?.send(message.data);
          return;
        }
        if (message.type === "cli:ws:close") {
          const key = message.evaluationId + ":" + message.id;
          webSockets.get(key)?.close();
          webSockets.delete(key);
          return;
        }
        const bridge = message.bridgeLoopbackServer ? createCliEvaluationHttpBridge() : null;
        const response = await evaluateCliModuleWorkerMessage(message, bridge ? { httpBridge: bridge } : {});
        if (bridge && response.result?.bridgedServerPorts?.length) httpBridges.set(message.id, bridge);
        parentPort.postMessage(response);
      } catch (error) {
        parentPort.postMessage({
          error: error instanceof Error ? error.stack || error.message : String(error),
          id: message.id,
          type: "cli:result"
        });
      }
    });
  `, { eval: true, type: "module" });

  constructor() {
    this.#worker.on("message", (data) => {
      for (const listener of this.#listeners.message) listener({ data });
    });
    this.#worker.on("error", (error) => {
      for (const listener of this.#listeners.error) listener({ message: error.message });
    });
  }

  addEventListener(type, listener) {
    this.#listeners[type]?.add(listener);
  }

  removeEventListener(type, listener) {
    this.#listeners[type]?.delete(listener);
  }

  postMessage(message) {
    this.#worker.postMessage(message);
  }

  terminate() {
    void this.#worker.terminate();
  }
}

const args = process.argv.slice(2);
const execute = args.includes("--execute");
const forceWasi = args.includes("--force-wasi");
const cliArgs = readListFlagValue(args, "--cli-args");
const executionIsolation = readFlagValue(args, "--execution-isolation") || "shared";
const fetchPaths = readListFlagValue(args, "--fetch-paths");
const projectFiles = readFlagValues(args, "--project-file");
const restartSmoke = args.includes("--restart-smoke");
const traceFs = args.includes("--trace-fs");
const wasmPolicyPath = readFlagValue(args, "--wasm-policy");
const websocketEdit = readFlagValue(args, "--websocket-edit");
const websocketEditDelayMs = readOptionalIntegerFlag(args, "--websocket-edit-delay-ms") ?? 1000;
const websocketPaths = readListFlagValue(args, "--websocket-paths");
const workerTimeoutMs = readOptionalIntegerFlag(args, "--worker-timeout-ms") ?? 1000;
const [vitePackageRootArg, nodeModulesRootArg] = args.filter((arg, index) => {
  if (arg === "--execute") return false;
  if (arg === "--cli-args") return false;
  if (arg === "--execution-isolation") return false;
  if (arg === "--fetch-paths") return false;
  if (arg === "--force-wasi") return false;
  if (arg === "--project-file") return false;
  if (arg === "--restart-smoke") return false;
  if (arg === "--trace-fs") return false;
  if (arg === "--wasm-policy") return false;
  if (arg === "--websocket-edit") return false;
  if (arg === "--websocket-edit-delay-ms") return false;
  if (arg === "--websocket-paths") return false;
  if (arg === "--worker-timeout-ms") return false;
  if (index > 0 && args[index - 1] === "--cli-args") return false;
  if (index > 0 && args[index - 1] === "--execution-isolation") return false;
  if (index > 0 && args[index - 1] === "--fetch-paths") return false;
  if (index > 0 && args[index - 1] === "--project-file") return false;
  if (index > 0 && args[index - 1] === "--wasm-policy") return false;
  if (index > 0 && args[index - 1] === "--websocket-edit") return false;
  if (index > 0 && args[index - 1] === "--websocket-edit-delay-ms") return false;
  if (index > 0 && args[index - 1] === "--websocket-paths") return false;
  if (index > 0 && args[index - 1] === "--worker-timeout-ms") return false;
  return true;
});

if (!vitePackageRootArg) {
  console.error("Usage: node tooling/checks/inspect-vite-package-artifact.ts <vite-package-root> [node-modules-root] [--execute] [--restart-smoke] [--cli-args <arg[,arg...]>] [--execution-isolation shared|snapshot|worker] [--fetch-paths <path[,path...]>] [--project-file <relative-path=source>] [--websocket-paths <path[,path...]>] [--websocket-edit <absolute-path=source>] [--websocket-edit-delay-ms <ms>] [--trace-fs] [--worker-timeout-ms <ms>] [--force-wasi] [--wasm-policy <manifest-json>]");
  process.exitCode = 1;
} else {
  const vitePackageRoot = resolve(vitePackageRootArg);
  if (!existsSync(`${vitePackageRoot}/package.json`)) {
    console.error(`Missing Vite package.json: ${vitePackageRoot}/package.json`);
    process.exitCode = 1;
  } else {
    const viteReader = createNodeFsWorkspaceReader({
      root: vitePackageRoot,
      virtualRoot: "/vendor/vite"
    });
    const vitePackageArtifact = createVitePackageArtifactFromWorkspace({
      reader: viteReader,
      packageRoot: "/vendor/vite"
    });
    const wasmAdapterPolicy = wasmPolicyPath ? createPolicyFromManifest(wasmPolicyPath) : null;
    const workflow = new ViteProductWorkflow({
      manager: "pnpm",
      ...(wasmAdapterPolicy ? { wasmAdapterPolicy } : {}),
      vitePackageArtifact
    });
    mountProjectFiles(workflow, projectFiles);
    workflow.install();
    const readiness = workflow.inspectRealCliReadiness();
    const dependencyClosure = nodeModulesRootArg
      ? inspectDependencyClosure(resolve(nodeModulesRootArg), vitePackageArtifact, wasmAdapterPolicy)
      : null;

    console.log(JSON.stringify({
      dependencyClosure,
      directReadiness: summarizeReadiness(readiness),
      executionSmoke: execute
        ? await runExecutionSmoke(vitePackageArtifact, dependencyClosure?.artifacts || [], { cliArgs, executionIsolation, fetchPaths, forceWasi, projectFiles, traceFs, wasmAdapterPolicy, websocketEdit, websocketEditDelayMs, websocketPaths, workerTimeoutMs })
        : null,
      restartSmoke: restartSmoke
        ? await runRestartSmoke(vitePackageArtifact, dependencyClosure?.artifacts || [], { cliArgs, executionIsolation, forceWasi, projectFiles, wasmAdapterPolicy, workerTimeoutMs })
        : null,
      hydratedReadiness: dependencyClosure
        ? summarizeReadiness(createHydratedWorkflowReadiness(vitePackageArtifact, dependencyClosure.artifacts, wasmAdapterPolicy))
        : null,
      wasmPolicy: wasmPolicyPath ? resolve(wasmPolicyPath) : null,
      vitePackageArtifact: {
        mountCount: vitePackageArtifact.mounts.length,
        version: vitePackageArtifact.version
      }
    }, null, 2));
  }
}

async function runExecutionSmoke(vitePackageArtifact, dependencyArtifacts, options) {
  if (!["shared", "snapshot", "worker"].includes(options.executionIsolation)) {
    throw new Error(`Unsupported --execution-isolation value: ${options.executionIsolation}`);
  }
  if (options.forceWasi && dependencyArtifacts.some((artifact) => artifact.name === "@napi-rs/wasm-runtime")) {
    return {
      env: { NAPI_RS_FORCE_WASI: "error" },
      exitCode: null,
      asyncBindingReadinessBlocker: null,
      asyncModuleBlocker: null,
      nativeBindingBlocker: null,
      registrations: null,
      runtimeBuiltinBlocker: null,
      skipped: true,
      skipReason: "wasi-runtime-host-exit-risk",
      stderrCauseLines: [],
      stderrFirstLine: null,
      stdoutFirstLine: null
    };
  }
  const workflow = new ViteProductWorkflow({
    dependencyArtifacts,
    manager: "pnpm",
    ...(options.wasmAdapterPolicy ? { wasmAdapterPolicy: options.wasmAdapterPolicy } : {}),
    vitePackageArtifact
  });
  mountProjectFiles(workflow, options.projectFiles);
  workflow.install();
  const env = {
    ...(process.env.DEBUG ? { DEBUG: process.env.DEBUG } : {}),
    ...(options.forceWasi ? { NAPI_RS_FORCE_WASI: "error" } : {})
  };
  let result;
  try {
    const args = options.cliArgs.length > 0 ? options.cliArgs : ["--host", "127.0.0.1"];
    result = await workflow.executeRealCli(args, env, {
      isolation: options.executionIsolation,
      readyTimeoutMs: 1000,
      ...(options.traceFs ? { traceFs: true } : {}),
      ...(options.executionIsolation === "worker"
        ? {
          workerFactory: () => new NodeThreadCliEvaluationWorker(),
          workerTimeoutMs: options.workerTimeoutMs
        }
        : {})
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      args: options.cliArgs.length > 0 ? options.cliArgs : ["--host", "127.0.0.1"],
      env,
      exitCode: 1,
      nativeBindingBlocker: null,
      isolation: options.executionIsolation,
      ...(options.traceFs ? { fsTrace: [] } : {}),
      isolationBlocker: null,
      registrations: null,
      runtimeBuiltinBlocker: null,
      asyncBindingReadinessBlocker: classifyAsyncBindingReadinessBlocker(message),
      asyncModuleBlocker: classifyAsyncModuleBlocker(message),
      timeoutBlocker: classifyTimeoutBlocker(message),
      wasiWorkerBootBlocker: classifyWasiWorkerBootBlocker(message, dependencyArtifacts, options.executionIsolation),
      stderrCauseLines: causeLines(message),
      stderrFirstLine: firstNonEmptyLine(message),
      stderrPreview: previewText(message),
      stdoutFirstLine: null,
      ...(options.fetchPaths.length > 0 ? { fetchResults: null } : {}),
      ...(options.executionIsolation === "worker" ? { workerTimeoutMs: options.workerTimeoutMs } : {})
    };
  }
  const fetchResults = await fetchExecutionSmokePaths(workflow, options.fetchPaths);
  const websocketResults = await connectExecutionSmokeWebSockets(workflow, options.websocketPaths, result, options.websocketEdit, options.websocketEditDelayMs);
  result.closeBridgedServers?.();
  const distArtifacts = summarizeDistArtifacts(result.workspaceSnapshot);
  return {
    args: result.args,
    env,
    exitCode: result.exitCode,
    isolation: options.executionIsolation,
    ...(options.traceFs && result.fsTrace ? { fsTrace: summarizeFsTrace(result.fsTrace) } : {}),
    nativeBindingBlocker: classifyNativeBindingBlocker(result.stderr),
    isolationBlocker: classifyIsolationBlocker(result.stderr),
    registrations: {
      build: result.buildRegistrations.length,
      hmr: result.hmrRegistrations.length,
      server: result.serverRegistrations.length,
      transform: result.transformRegistrations.length
    },
    runtimeBuiltinBlocker: classifyRuntimeBuiltinBlocker(result.stderr),
    asyncBindingReadinessBlocker: classifyAsyncBindingReadinessBlocker(result.stderr),
    asyncModuleBlocker: classifyAsyncModuleBlocker(result.stderr),
    timeoutBlocker: classifyTimeoutBlocker(result.stderr),
    wasiWorkerBootBlocker: classifyWasiWorkerBootBlocker(result.stderr, dependencyArtifacts, options.executionIsolation),
    stderrCauseLines: causeLines(result.stderr),
    stderrFirstLine: firstNonEmptyLine(result.stderr),
    stderrPreview: previewText(result.stderr),
    stdoutFirstLine: firstNonEmptyLine(result.stdout),
    stdoutPreview: previewText(result.stdout),
    distArtifactBlocker: classifyDistArtifactBlocker(result.args, result.exitCode, distArtifacts),
    distArtifacts,
    ...(fetchResults ? { fetchResults } : {}),
    ...(websocketResults ? { websocketResults } : {}),
    ...(options.executionIsolation === "worker" ? { workerTimeoutMs: options.workerTimeoutMs } : {})
  };
}

async function runRestartSmoke(vitePackageArtifact, dependencyArtifacts, options) {
  if (options.executionIsolation !== "worker") {
    return {
      skipped: true,
      skipReason: "restart smoke currently requires --execution-isolation worker"
    };
  }
  const workflow = new ViteProductWorkflow({
    dependencyArtifacts,
    manager: "pnpm",
    ...(options.wasmAdapterPolicy ? { wasmAdapterPolicy: options.wasmAdapterPolicy } : {}),
    vitePackageArtifact
  });
  mountProjectFiles(workflow, options.projectFiles);
  workflow.install();
  const env = {
    ...(process.env.DEBUG ? { DEBUG: process.env.DEBUG } : {}),
    ...(options.forceWasi ? { NAPI_RS_FORCE_WASI: "error" } : {})
  };
  const args = options.cliArgs.length > 0 ? options.cliArgs : ["--host", "127.0.0.1"];
  let first;
  let second;
  let stoppedFetch;
  try {
    first = await workflow.executeRealCli(args, env, {
      isolation: "worker",
      readyTimeoutMs: 1000,
      workerFactory: () => new NodeThreadCliEvaluationWorker(),
      workerTimeoutMs: options.workerTimeoutMs
    });
    const firstFetch = await fetchExecutionSmokePath(workflow, "/");
    first.closeBridgedServers?.();
    stoppedFetch = await fetchExecutionSmokePath(workflow, "/");
    second = await workflow.executeRealCli(args, env, {
      isolation: "worker",
      readyTimeoutMs: 1000,
      workerFactory: () => new NodeThreadCliEvaluationWorker(),
      workerTimeoutMs: options.workerTimeoutMs
    });
    const secondFetch = await fetchExecutionSmokePath(workflow, "/");
    second.closeBridgedServers?.();
    return {
      args,
      env,
      first: summarizeRestartCliRun(first, firstFetch),
      restartBlocker: classifyRestartBlocker(first, firstFetch, stoppedFetch, second, secondFetch),
      second: summarizeRestartCliRun(second, secondFetch),
      stoppedFetch,
      workerTimeoutMs: options.workerTimeoutMs
    };
  } catch (error) {
    first?.closeBridgedServers?.();
    second?.closeBridgedServers?.();
    return {
      args,
      env,
      error: error instanceof Error ? error.message : String(error),
      restartBlocker: {
        code: "EVITERESTARTFAILED",
        reason: "actual Vite worker restart smoke threw before completing"
      },
      workerTimeoutMs: options.workerTimeoutMs
    };
  }
}

function summarizeRestartCliRun(result, fetchResult) {
  return {
    exitCode: result.exitCode,
    fetch: fetchResult,
    stderrFirstLine: firstNonEmptyLine(result.stderr),
    stdoutFirstLine: firstNonEmptyLine(result.stdout)
  };
}

function classifyRestartBlocker(first, firstFetch, stoppedFetch, second, secondFetch) {
  if (first.exitCode !== 0) {
    return {
      code: "EVITERESTARTFIRSTEXIT",
      reason: "first actual Vite worker CLI run did not start cleanly"
    };
  }
  if (firstFetch.status !== 200) {
    return {
      code: "EVITERESTARTFIRSTFETCH",
      reason: "first actual Vite worker server did not serve preview"
    };
  }
  if (stoppedFetch.status !== null) {
    return {
      code: "EVITERESTARTSTOP",
      reason: "preview was still reachable after closing the first worker bridge"
    };
  }
  if (second.exitCode !== 0) {
    return {
      code: "EVITERESTARTSECONDEXIT",
      reason: "second actual Vite worker CLI run did not start cleanly"
    };
  }
  if (secondFetch.status !== 200) {
    return {
      code: "EVITERESTARTSECONDFETCH",
      reason: "second actual Vite worker server did not serve preview"
    };
  }
  return null;
}

function classifyDistArtifactBlocker(args, exitCode, distArtifacts) {
  if (!args.includes("build")) return null;
  if (exitCode !== 0) return null;
  if (!distArtifacts || distArtifacts.count > 0) return null;
  return {
    code: "EVITEDISTEMPTY",
    reason: "build-exited-without-dist-artifacts"
  };
}

function summarizeDistArtifacts(workspaceSnapshot) {
  if (!workspaceSnapshot?.files) return null;
  const files = workspaceSnapshot.files
    .filter((file) => file.path.startsWith("/workspace/project/dist/"))
    .map((file) => ({
      encoding: file.encoding,
      path: file.path.replace("/workspace/project/", ""),
      size: String(file.data || "").length
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
  return {
    count: files.length,
    files
  };
}

async function fetchExecutionSmokePaths(workflow, fetchPaths) {
  if (!fetchPaths || fetchPaths.length === 0) return null;
  const results = [];
  for (const path of fetchPaths) {
    results.push(await fetchExecutionSmokePath(workflow, path));
  }
  return results;
}

async function fetchExecutionSmokePath(workflow, path) {
  try {
    const response = await workflow.fetch(`http://127.0.0.1:5173${path}`, {
      headers: headersForFetchPath(path)
    });
    return {
      bodyStart: (await response.text()).slice(0, 2000),
      contentType: response.headers.get("content-type"),
      path,
      status: response.status
    };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error),
      path,
      status: null
    };
  }
}

async function connectExecutionSmokeWebSockets(workflow, websocketPaths, executionResult, websocketEdit, websocketEditDelayMs) {
  if (!websocketPaths || websocketPaths.length === 0) return null;
  const results = [];
  for (const path of websocketPaths) {
    const messages = [];
    const edit = parseWebSocketEdit(websocketEdit);
    let editResult = null;
    let postEditFetch = null;
    try {
      const socket = workflow.network.connectWebSocket(`ws://127.0.0.1:5173${path}`, { protocol: "vite-hmr" });
      socket.onmessage = (event) => messages.push(event.data);
      await Promise.resolve();
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 10));
      if (edit && executionResult.writeBridgedFile) {
        await new Promise((resolve) => setTimeout(resolve, websocketEditDelayMs));
        editResult = await executionResult.writeBridgedFile(edit.path, edit.data);
        await new Promise((resolve) => setTimeout(resolve, 1000));
        postEditFetch = await fetchExecutionSmokePath(workflow, projectPathToUrl(edit.path));
      }
      socket.close();
      const messageTypes = messages.map((message) => parseMessageType(message));
      results.push({
        ...(edit ? { editPath: edit.path } : {}),
        ...(editResult ? { editResult } : {}),
        ...(postEditFetch ? { postEditFetch } : {}),
        hmrUpdateBlocker: classifyHmrUpdateBlocker(edit, executionResult, editResult, messageTypes),
        messages: messages.map((message) => previewText(message)),
        messageTypes,
        path,
        protocol: socket.protocol,
        status: "connected"
      });
    } catch (error) {
      results.push({
        error: error instanceof Error ? error.message : String(error),
        messages,
        path,
        protocol: "vite-hmr",
        status: "error"
      });
    }
  }
  return results;
}

function projectPathToUrl(path) {
  if (!path.startsWith("/workspace/project/")) return path;
  return "/" + path.slice("/workspace/project/".length);
}

function classifyHmrUpdateBlocker(edit, executionResult, editResult, messageTypes) {
  if (!edit) return null;
  if (!executionResult.writeBridgedFile) {
    return {
      code: "EVITEHMRWRITEUNAVAILABLE",
      reason: "worker-backed VFS edit bridge is unavailable"
    };
  }
  if (messageTypes.some((type) => type === "update" || type === "full-reload" || type === "error")) return null;
  if (editResult && editResult.watcherCount > 0) {
    return {
      code: "EVITEHMRNOBROADCAST",
      reason: "Vite file watchers are registered, but no HMR update payload was observed after worker VFS edit"
    };
  }
  return {
    code: "EVITEHMRNOUPDATE",
    reason: "no Vite HMR update payload was observed after worker VFS edit"
  };
}

function parseWebSocketEdit(value) {
  if (!value) return null;
  const separator = value.indexOf("=");
  if (separator <= 0) throw new Error("--websocket-edit must use <absolute-path=source>");
  return {
    data: value.slice(separator + 1).replaceAll("\\n", "\n"),
    path: value.slice(0, separator)
  };
}

function mountProjectFiles(workflow, values) {
  for (const value of values || []) {
    const file = parseProjectFile(value);
    if (!file) continue;
    workflow.workspace.writeText(`${workflow.projectRoot}/${file.path}`, file.data);
  }
}

function parseProjectFile(value) {
  if (!value) return null;
  const separator = value.indexOf("=");
  if (separator <= 0) throw new Error("--project-file must use <relative-path=source>");
  return {
    data: value.slice(separator + 1).replaceAll("\\n", "\n"),
    path: value.slice(0, separator).replace(/^\/+/, "")
  };
}

function parseMessageType(message) {
  try {
    return JSON.parse(message).type || null;
  } catch {
    return null;
  }
}

function headersForFetchPath(path) {
  if (path.startsWith("/@vite/") || path.startsWith("/@id/") || /\.[cm]?[jt]sx?(?:$|\?)/.test(path)) {
    return {
      accept: "*/*",
      "sec-fetch-dest": "script"
    };
  }
  if (/\.css(?:$|\?)/.test(path)) {
    return {
      accept: "text/css,*/*;q=0.1",
      "sec-fetch-dest": "style"
    };
  }
  return {
    accept: "text/html,application/xhtml+xml"
  };
}

function summarizeFsTrace(entries) {
  const summary = [];
  const seen = new Map();
  for (const entry of entries) {
    const key = `${entry.op}:${entry.path}:${entry.result ?? ""}:${entry.error ?? ""}`;
    const existing = seen.get(key);
    if (existing) {
      existing.count += 1;
      continue;
    }
    const item = {
      count: 1,
      op: entry.op,
      path: entry.path,
      ...(entry.result === undefined ? {} : { result: entry.result }),
      ...(entry.error === undefined ? {} : { error: entry.error })
    };
    seen.set(key, item);
    summary.push(item);
  }
  return summary.slice(0, 200);
}

function inspectDependencyClosure(nodeModulesRoot, vitePackageArtifact, wasmAdapterPolicy) {
  const reader = createDependencyReader(nodeModulesRoot);
  const closure = createViteDependencyArtifactClosureFromWorkspace({
    manager: "pnpm",
    nodeModulesRoot: "/workspace/project/node_modules",
    reader,
    vitePackageArtifact,
    ...(wasmAdapterPolicy ? { wasmAdapterPolicy } : {})
  });
  const result = {
    artifactNames: closure.artifacts.map((artifact) => artifact.name),
    artifactMountSummary: closure.artifacts.map((artifact) => ({
      binaryMountCount: artifact.mounts.filter((mount) => mount.encoding === "base64").length,
      mountCount: artifact.mounts.length,
      name: artifact.name
    })),
    iterations: closure.iterations.map((iteration) => ({
      extracted: iteration.extracted,
      remainingMissing: iteration.plan.missing.map((item) => ({
        kind: item.kind,
        name: item.name,
        specifiers: item.specifiers
      }))
    })),
    remainingPlan: summarizePlan(closure.remainingPlan),
    sourceRoot: nodeModulesRoot
  };
  Object.defineProperty(result, "artifacts", {
    enumerable: false,
    value: closure.artifacts
  });
  return result;
}

function createHydratedWorkflowReadiness(vitePackageArtifact, dependencyArtifacts, wasmAdapterPolicy) {
  const workflow = new ViteProductWorkflow({
    dependencyArtifacts,
    manager: "pnpm",
    ...(wasmAdapterPolicy ? { wasmAdapterPolicy } : {}),
    vitePackageArtifact
  });
  workflow.install();
  return workflow.inspectRealCliReadiness();
}

function createDependencyReader(nodeModulesRoot) {
  const readers = [createNodeFsWorkspaceReader({
    root: nodeModulesRoot,
    virtualRoot: "/workspace/project/node_modules"
  })];
  const pnpmHoistedRoot = `${nodeModulesRoot}/.pnpm/node_modules`;
  if (existsSync(pnpmHoistedRoot)) {
    readers.push(createNodeFsWorkspaceReader({
      root: pnpmHoistedRoot,
      virtualRoot: "/workspace/project/node_modules"
    }));
  }
  return createFallbackWorkspaceReader(readers);
}

function createPolicyFromManifest(path) {
  return createWasmAdapterPolicy(JSON.parse(readFileSync(resolve(path), "utf8")));
}

function readFlagValue(values, flag) {
  const inline = values.find((value) => value.startsWith(`${flag}=`));
  if (inline) return inline.slice(flag.length + 1);
  const index = values.indexOf(flag);
  if (index < 0) return null;
  const value = values[index + 1];
  if (!value || value.startsWith("--")) {
    console.error(`Missing value for ${flag}`);
    process.exit(1);
  }
  return value;
}

function readFlagValues(values, flag) {
  const result = [];
  for (let index = 0; index < values.length; index++) {
    const value = values[index];
    if (value.startsWith(`${flag}=`)) {
      result.push(value.slice(flag.length + 1));
      continue;
    }
    if (value !== flag) continue;
    const next = values[index + 1];
    if (!next || next.startsWith("--")) {
      console.error(`Missing value for ${flag}`);
      process.exit(1);
    }
    result.push(next);
  }
  return result;
}

function readListFlagValue(values, flag) {
  const value = readFlagValue(values, flag);
  if (value === null) return [];
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function readOptionalIntegerFlag(values, flag) {
  const value = readFlagValue(values, flag);
  if (value === null) return null;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) {
    console.error(`Expected ${flag} to be a positive integer`);
    process.exit(1);
  }
  return number;
}

function summarizeReadiness(readiness) {
  return {
    blockedCapabilities: readiness.capabilityStatus.filter((capability) => capability.status === "blocked").map((capability) => capability.capability),
    cliEntrypoint: readiness.cliEntrypoint,
    entryMode: readiness.cliEntryReadiness.mode,
    graphIssues: readiness.cliModuleGraph.issues.map((issue) => ({
      importer: issue.importer,
      kind: issue.kind,
      specifier: issue.specifier
    })),
    moduleCount: readiness.cliModuleGraph.modules.length,
    nextAction: readiness.nextAction,
    plan: summarizePlan(readiness.dependencyMaterializationPlan),
    status: readiness.status,
    vitePackageSource: readiness.vitePackageSource
  };
}

function summarizePlan(plan) {
  return {
    missing: plan.missing.map((item) => ({
      artifactNames: item.artifactNames,
      kind: item.kind,
      name: item.name,
      specifiers: item.specifiers,
      wasm: item.wasm
    })),
    optional: plan.optional.map((item) => ({
      kind: item.kind,
      name: item.name,
      specifier: item.specifier
    })),
    satisfied: plan.satisfied,
    summary: plan.summary
  };
}

function classifyNativeBindingBlocker(stderr) {
  if (!stderr.includes("Cannot find native binding") && !stderr.includes("WASI binding not found")) return null;
  return {
    packageName: inferNativeBindingPackageName(stderr),
    reason: "native-binding-runtime-error"
  };
}

function classifyIsolationBlocker(stderr) {
  if (!stderr.includes("EVITEWASIISOLATIONREQUIRED") && !stderr.includes("EVITEWASISYNCINIT")) return null;
  return {
    reason: stderr.includes("EVITEWASIISOLATIONREQUIRED")
      ? "wasi-runtime-shared-execution-requires-isolation"
      : "forced-wasi-sync-init-requires-isolation"
  };
}

function classifyRuntimeBuiltinBlocker(stderr) {
  const match = stderr.match(/ERR_MODULE_NOT_FOUND: (node:[\w-]+)/);
  if (!match) return null;
  return {
    builtin: match[1],
    reason: "missing-runtime-builtin"
  };
}

function classifyAsyncModuleBlocker(stderr) {
  const match = stderr.match(/ERR_REQUIRE_ASYNC_MODULE: ([^\n]+)/);
  if (!match) return null;
  return {
    module: match[1],
    reason: "sync-require-of-async-esm"
  };
}

function classifyAsyncBindingReadinessBlocker(stderr) {
  if (!stderr.includes("Class extends value undefined is not a constructor or null")) return null;
  return {
    reason: "async-binding-namespace-not-ready"
  };
}

function classifyTimeoutBlocker(stderr) {
  if (!stderr.includes("ECLIETIMEOUT") && !stderr.includes("ECLIEWORKERTIMEOUT")) return null;
  return {
    reason: stderr.includes("ECLIEWORKERTIMEOUT") ? "cli-worker-response-timeout" : "cli-module-ready-timeout"
  };
}

function classifyWasiWorkerBootBlocker(stderr, dependencyArtifacts, executionIsolation) {
  if (executionIsolation !== "worker") return null;
  if (!stderr.includes("ECLIEWORKERTIMEOUT")) return null;
  const artifactNames = new Set(dependencyArtifacts.map((artifact) => artifact.name));
  if (!artifactNames.has("@napi-rs/wasm-runtime") && !artifactNames.has("@rolldown/binding-wasm32-wasi")) return null;
  return {
    reason: "rolldown-wasi-worker-boot-timeout",
    runtime: artifactNames.has("@napi-rs/wasm-runtime") ? "@napi-rs/wasm-runtime" : "@rolldown/binding-wasm32-wasi"
  };
}

function inferNativeBindingPackageName(stderr) {
  if (stderr.includes("/node_modules/rolldown/")) return "rolldown";
  const scopedPackageMatch = stderr.match(/\/node_modules\/(@[^/]+\/[^/]+)\//);
  if (scopedPackageMatch) return scopedPackageMatch[1];
  const packageMatch = stderr.match(/\/node_modules\/([^/@][^/]*)\//);
  return packageMatch ? packageMatch[1] : null;
}

function firstNonEmptyLine(value) {
  return value.split(/\r?\n/).find((line) => line.trim().length > 0) || null;
}

function previewText(value) {
  const text = String(value || "").trim();
  return text.length > 0 ? text.slice(0, 2000) : null;
}

function causeLines(value) {
  return value
    .split(/\r?\n/)
    .filter((line) => line.startsWith("Caused by:"))
    .slice(0, 8);
}
