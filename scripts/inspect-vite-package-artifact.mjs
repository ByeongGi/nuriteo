#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  createWasmAdapterPolicy,
  createViteDependencyArtifactClosureFromWorkspace,
  createVitePackageArtifactFromWorkspace,
  ViteProductWorkflow
} from "../packages/node-runtime/src/index.ts";
import { createFallbackWorkspaceReader, createNodeFsWorkspaceReader } from "./lib/fs-workspace-reader.mjs";

const args = process.argv.slice(2);
const execute = args.includes("--execute");
const forceWasi = args.includes("--force-wasi");
const wasmPolicyPath = readFlagValue(args, "--wasm-policy");
const [vitePackageRootArg, nodeModulesRootArg] = args.filter((arg, index) => {
  if (arg === "--execute") return false;
  if (arg === "--force-wasi") return false;
  if (arg === "--wasm-policy") return false;
  if (index > 0 && args[index - 1] === "--wasm-policy") return false;
  return true;
});

if (!vitePackageRootArg) {
  console.error("Usage: node scripts/inspect-vite-package-artifact.mjs <vite-package-root> [node-modules-root] [--execute] [--force-wasi] [--wasm-policy <manifest-json>]");
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
        ? await runExecutionSmoke(vitePackageArtifact, dependencyClosure?.artifacts || [], { forceWasi, wasmAdapterPolicy })
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
  if (options.forceWasi && dependencyArtifacts.some((artifact) => artifact.name === "@napi-rs/wasm-runtime")) {
    return {
      env: { NAPI_RS_FORCE_WASI: "error" },
      exitCode: null,
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
  const result = await workflow.executeRealCli(["--host", "127.0.0.1"], env);
  return {
    args: result.args,
    env,
    exitCode: result.exitCode,
    nativeBindingBlocker: classifyNativeBindingBlocker(result.stderr),
    registrations: {
      build: result.buildRegistrations.length,
      hmr: result.hmrRegistrations.length,
      server: result.serverRegistrations.length,
      transform: result.transformRegistrations.length
    },
    runtimeBuiltinBlocker: classifyRuntimeBuiltinBlocker(result.stderr),
    stderrCauseLines: causeLines(result.stderr),
    stderrFirstLine: firstNonEmptyLine(result.stderr),
    stdoutFirstLine: firstNonEmptyLine(result.stdout)
  };
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

function classifyRuntimeBuiltinBlocker(stderr) {
  const match = stderr.match(/ERR_MODULE_NOT_FOUND: (node:[\w-]+)/);
  if (!match) return null;
  return {
    builtin: match[1],
    reason: "missing-runtime-builtin"
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

function causeLines(value) {
  return value
    .split(/\r?\n/)
    .filter((line) => line.startsWith("Caused by:"))
    .slice(0, 8);
}
