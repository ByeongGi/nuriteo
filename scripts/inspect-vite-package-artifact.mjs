#!/usr/bin/env node
import { existsSync } from "node:fs";
import { resolve } from "node:path";

import {
  createViteDependencyArtifactClosureFromWorkspace,
  createVitePackageArtifactFromWorkspace,
  ViteProductWorkflow
} from "../packages/node-runtime/src/index.ts";
import { createNodeFsWorkspaceReader } from "./lib/fs-workspace-reader.mjs";

const [vitePackageRootArg, nodeModulesRootArg] = process.argv.slice(2);

if (!vitePackageRootArg) {
  console.error("Usage: node scripts/inspect-vite-package-artifact.mjs <vite-package-root> [node-modules-root]");
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
      vitePackageArtifact: {
        mountCount: vitePackageArtifact.mounts.length,
        version: vitePackageArtifact.version
      }
    }, null, 2));
  }
}

function inspectDependencyClosure(nodeModulesRoot, vitePackageArtifact) {
  const reader = createNodeFsWorkspaceReader({
    root: nodeModulesRoot,
    virtualRoot: "/workspace/project/node_modules"
  });
  const closure = createViteDependencyArtifactClosureFromWorkspace({
    manager: "pnpm",
    nodeModulesRoot: "/workspace/project/node_modules",
    reader,
    vitePackageArtifact
  });
  return {
    artifactNames: closure.artifacts.map((artifact) => artifact.name),
    iterations: closure.iterations.map((iteration) => ({
      extracted: iteration.extracted,
      remainingMissing: iteration.plan.missing.map((item) => ({
        kind: item.kind,
        name: item.name,
        specifiers: item.specifiers
      }))
    })),
    remainingPlan: summarizePlan(closure.remainingPlan)
  };
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
