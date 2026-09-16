#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Worker } from "node:worker_threads";

import {
  createWasmAdapterPolicy,
  createViteDependencyArtifactClosureFromWorkspace,
  createVitePackageArtifactFromWorkspace,
  ViteProductWorkflow
} from "../packages/node-runtime/src/index.ts";
import { createFallbackWorkspaceReader, createNodeFsWorkspaceReader } from "./lib/fs-workspace-reader.mjs";

class NodeThreadCliEvaluationWorker {
  #listeners = {
    message: new Set(),
    error: new Set()
  };
  #worker = new Worker(`
    import { parentPort } from "node:worker_threads";
    import { createCliEvaluationHttpBridge, evaluateCliModuleWorkerMessage } from ${JSON.stringify(new URL("../packages/node-runtime/src/package-managers/cli-evaluator.ts", import.meta.url).href)};
    const httpBridges = new Map();
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
const executionIsolation = readFlagValue(args, "--execution-isolation") || "shared";
const fetchPaths = readListFlagValue(args, "--fetch-paths");
const traceFs = args.includes("--trace-fs");
const wasmPolicyPath = readFlagValue(args, "--wasm-policy");
const workerTimeoutMs = readOptionalIntegerFlag(args, "--worker-timeout-ms") ?? 1000;
const [vitePackageRootArg, nodeModulesRootArg] = args.filter((arg, index) => {
  if (arg === "--execute") return false;
  if (arg === "--execution-isolation") return false;
  if (arg === "--fetch-paths") return false;
  if (arg === "--force-wasi") return false;
  if (arg === "--trace-fs") return false;
  if (arg === "--wasm-policy") return false;
  if (arg === "--worker-timeout-ms") return false;
  if (index > 0 && args[index - 1] === "--execution-isolation") return false;
  if (index > 0 && args[index - 1] === "--fetch-paths") return false;
  if (index > 0 && args[index - 1] === "--wasm-policy") return false;
  if (index > 0 && args[index - 1] === "--worker-timeout-ms") return false;
  return true;
});

if (!vitePackageRootArg) {
  console.error("Usage: node scripts/inspect-vite-package-artifact.mjs <vite-package-root> [node-modules-root] [--execute] [--execution-isolation shared|snapshot|worker] [--fetch-paths <path[,path...]>] [--trace-fs] [--worker-timeout-ms <ms>] [--force-wasi] [--wasm-policy <manifest-json>]");
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
    workflow.install();
    const readiness = workflow.inspectRealCliReadiness();
    const dependencyClosure = nodeModulesRootArg
      ? inspectDependencyClosure(resolve(nodeModulesRootArg), vitePackageArtifact, wasmAdapterPolicy)
      : null;

    console.log(JSON.stringify({
      dependencyClosure,
      directReadiness: summarizeReadiness(readiness),
      executionSmoke: execute
        ? await runExecutionSmoke(vitePackageArtifact, dependencyClosure?.artifacts || [], { executionIsolation, fetchPaths, forceWasi, traceFs, wasmAdapterPolicy, workerTimeoutMs })
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
  workflow.install();
  const env = options.forceWasi ? { NAPI_RS_FORCE_WASI: "error" } : {};
  let result;
  try {
    result = await workflow.executeRealCli(["--host", "127.0.0.1"], env, {
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
      args: ["--host", "127.0.0.1"],
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
  result.closeBridgedServers?.();
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
    ...(fetchResults ? { fetchResults } : {}),
    ...(options.executionIsolation === "worker" ? { workerTimeoutMs: options.workerTimeoutMs } : {})
  };
}

async function fetchExecutionSmokePaths(workflow, fetchPaths) {
  if (!fetchPaths || fetchPaths.length === 0) return null;
  const results = [];
  for (const path of fetchPaths) {
    try {
      const response = await workflow.fetch(`http://127.0.0.1:5173${path}`, {
        headers: headersForFetchPath(path)
      });
      results.push({
        bodyStart: (await response.text()).slice(0, 160),
        contentType: response.headers.get("content-type"),
        path,
        status: response.status
      });
    } catch (error) {
      results.push({
        error: error instanceof Error ? error.message : String(error),
        path,
        status: null
      });
    }
  }
  return results;
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
  const index = values.indexOf(flag);
  if (index < 0) return null;
  const value = values[index + 1];
  if (!value || value.startsWith("--")) {
    console.error(`Missing value for ${flag}`);
    process.exit(1);
  }
  return value;
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
