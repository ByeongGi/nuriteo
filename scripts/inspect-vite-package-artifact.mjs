#!/usr/bin/env node
import { existsSync } from "node:fs";
import { resolve } from "node:path";

import {
  createViteDependencyArtifactClosureFromWorkspace,
  createVitePackageArtifactFromWorkspace,
  ViteProductWorkflow
} from "../packages/node-runtime/src/index.ts";
import { createFallbackWorkspaceReader, createNodeFsWorkspaceReader } from "./lib/fs-workspace-reader.mjs";

const args = process.argv.slice(2);
const execute = args.includes("--execute");
const [vitePackageRootArg, nodeModulesRootArg] = args.filter((arg) => arg !== "--execute");

if (!vitePackageRootArg) {
  console.error("Usage: node scripts/inspect-vite-package-artifact.mjs <vite-package-root> [node-modules-root] [--execute]");
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
    const workflow = new ViteProductWorkflow({
      manager: "pnpm",
      vitePackageArtifact
    });
    workflow.install();
    const readiness = workflow.inspectRealCliReadiness();
    const dependencyClosure = nodeModulesRootArg
      ? inspectDependencyClosure(resolve(nodeModulesRootArg), vitePackageArtifact)
      : null;

    console.log(JSON.stringify({
      dependencyClosure,
      directReadiness: summarizeReadiness(readiness),
      executionSmoke: execute
        ? await runExecutionSmoke(vitePackageArtifact, dependencyClosure?.artifacts || [])
        : null,
      hydratedReadiness: dependencyClosure
        ? summarizeReadiness(createHydratedWorkflowReadiness(vitePackageArtifact, dependencyClosure.artifacts))
        : null,
      vitePackageArtifact: {
        mountCount: vitePackageArtifact.mounts.length,
        version: vitePackageArtifact.version
      }
    }, null, 2));
  }
}

async function runExecutionSmoke(vitePackageArtifact, dependencyArtifacts) {
  const workflow = new ViteProductWorkflow({
    dependencyArtifacts,
    manager: "pnpm",
    vitePackageArtifact
  });
  workflow.install();
  const result = await workflow.executeRealCli(["--host", "127.0.0.1"]);
  return {
    args: result.args,
    exitCode: result.exitCode,
    nativeBindingBlocker: classifyNativeBindingBlocker(result.stderr),
    registrations: {
      build: result.buildRegistrations.length,
      hmr: result.hmrRegistrations.length,
      server: result.serverRegistrations.length,
      transform: result.transformRegistrations.length
    },
    stderrFirstLine: firstNonEmptyLine(result.stderr),
    stdoutFirstLine: firstNonEmptyLine(result.stdout)
  };
}

function inspectDependencyClosure(nodeModulesRoot, vitePackageArtifact) {
  const reader = createDependencyReader(nodeModulesRoot);
  const closure = createViteDependencyArtifactClosureFromWorkspace({
    manager: "pnpm",
    nodeModulesRoot: "/workspace/project/node_modules",
    reader,
    vitePackageArtifact
  });
  const result = {
    artifactNames: closure.artifacts.map((artifact) => artifact.name),
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

function createHydratedWorkflowReadiness(vitePackageArtifact, dependencyArtifacts) {
  const workflow = new ViteProductWorkflow({
    dependencyArtifacts,
    manager: "pnpm",
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
  if (!stderr.includes("Cannot find native binding")) return null;
  return {
    packageName: inferNativeBindingPackageName(stderr),
    reason: "native-binding-runtime-error"
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
