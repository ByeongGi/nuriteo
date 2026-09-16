#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import {
  createViteDependencyArtifactClosureFromWorkspace,
  createViteDependencyArtifactsFromWorkspace,
  createVitePackageArtifactFromWorkspace,
  createWasmAdapterPolicy,
  mergeViteDependencyArtifacts,
  ViteProductWorkflow
} from "../packages/node-runtime/src/index.ts";
import { resolveViteHmrUrl } from "../packages/preview/src/index.ts";
import { createFallbackWorkspaceReader, createNodeFsWorkspaceReader } from "./lib/fs-workspace-reader.mjs";
import { NodeThreadCliEvaluationWorker } from "./lib/node-thread-cli-worker.mjs";

const root = new URL("..", import.meta.url).pathname;
const matrixPath = path.join(root, "compat/ecosystem-fixtures.json");
const matrix = JSON.parse(fs.readFileSync(matrixPath, "utf8"));
const args = new Set(process.argv.slice(2));
const planOnly = args.has("--plan");
const mode = valueAfter("--mode") || "reference";
const selectedIds = valueAfter("--fixtures")?.split(",").filter(Boolean) || matrix.fixtures.map((fixture) => fixture.id);
const workdir = valueAfter("--workdir") || path.join(os.tmpdir(), "cargo-container-ecosystem-fixtures");
const outputPath = valueAfter("--output") || path.join(root, defaultOutputForMode(mode));
const actualVitePackageRoot = valueAfter("--vite-package-root");
const actualNodeModulesRoot = valueAfter("--node-modules-root");
const actualWasmPolicyPath = valueAfter("--wasm-policy");
const actualWorkerTimeoutMs = Number(valueAfter("--worker-timeout-ms") || "10000");
const useSharedFixtureNodeModules = args.has("--shared-fixture-node-modules");
let actualProductContext = null;

const selected = matrix.fixtures.filter((fixture) => selectedIds.includes(fixture.id));
if (selected.length !== selectedIds.length) {
  const known = new Set(matrix.fixtures.map((fixture) => fixture.id));
  const missing = selectedIds.filter((id) => !known.has(id));
  throw new Error(`Unknown fixture id: ${missing.join(", ")}`);
}

const results = [];
for (const fixture of selected) {
  results.push(planOnly ? plannedResult(fixture) : await scoreFixture(fixture, mode));
}
const payload = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  source: "compat/ecosystem-fixtures.json",
  minimumPassForMilestoneB: matrix.scope.minimumPassForMilestoneB,
  results,
  failureSummary: summarizeFailures(results),
  summary: summarize(results)
};

if (planOnly) {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
} else {
  fs.writeFileSync(outputPath, `${JSON.stringify(payload, null, 2)}\n`);
  process.stdout.write(`ecosystem fixture results written: ${path.relative(root, outputPath)}\n`);
}

function plannedResult(fixture) {
  return {
    id: fixture.id,
    name: fixture.name,
    mode: "plan",
    packageManager: fixture.packageManager,
    repository: fixture.repository,
    subdirectory: fixture.subdirectory || null,
    expectedCommands: fixture.expectedCommands,
    score: 0,
    status: "not-run",
    unsupportedBlocker: false,
    criteria: matrix.scoringRubric.criteria.map((criterion) => ({
      id: criterion.id,
      points: criterion.points,
      status: "not-run"
    }))
  };
}

async function scoreFixture(fixture, scoreMode) {
  if (scoreMode === "product-adapter") return scoreProductAdapterFixture(fixture);
  if (scoreMode === "product-actual") {
    return withTimeout(
      scoreProductActualFixture(fixture),
      actualWorkerTimeoutMs * 2 + 10000,
      `EACTUALFIXTURETIMEOUT: actual product fixture scoring did not settle for ${fixture.id}`
    ).catch((error) => blockedActualResult(fixture, "dev-preview", error));
  }
  if (scoreMode !== "reference") throw new Error(`Unsupported score mode: ${scoreMode}`);

  const checkout = path.join(workdir, fixture.id);
  const projectDir = fixture.subdirectory ? path.join(checkout, fixture.subdirectory) : checkout;
  const criteria = [];
  fs.mkdirSync(workdir, { recursive: true });
  if (!fs.existsSync(checkout)) {
    const clone = run("git", ["clone", "--depth", "1", fixture.repository, checkout], workdir);
    if (clone.status !== 0) return failedResult(fixture, "install", clone);
  }

  const install = runCommandString(fixture.expectedCommands.install, projectDir);
  criteria.push(criterion("install", install.status === 0, install));
  const build = runCommandString(fixture.expectedCommands.build, projectDir);
  criteria.push(criterion("build-dist", build.status === 0, build));

  const { devPreview, editHmr } = await runDevPreviewAndHmr(fixture.expectedCommands.dev, projectDir);
  criteria.push(criterion("dev-preview", devPreview.status === 0, devPreview));
  criteria.push(criterion("edit-hmr", editHmr.status === 0, editHmr));

  const score = criteria.reduce((total, entry) => total + (entry.status === "pass" ? entry.points : 0), 0);
  return {
    id: fixture.id,
    name: fixture.name,
    mode: "measured-reference",
    packageManager: fixture.packageManager,
    repository: fixture.repository,
    subdirectory: fixture.subdirectory || null,
    score,
    status: classifyScore(score, false),
    unsupportedBlocker: false,
    criteria
  };
}

function getActualProductContext() {
  if (actualProductContext) return actualProductContext;
  if (!actualVitePackageRoot || !actualNodeModulesRoot) {
    actualProductContext = {
      error: new Error("--mode=product-actual requires --vite-package-root and --node-modules-root")
    };
    return actualProductContext;
  }
  try {
    const vitePackageRoot = path.resolve(actualVitePackageRoot);
    const nodeModulesRoot = path.resolve(actualNodeModulesRoot);
    const viteReader = createNodeFsWorkspaceReader({
      root: vitePackageRoot,
      virtualRoot: "/vendor/vite"
    });
    const vitePackageArtifact = createVitePackageArtifactFromWorkspace({
      packageRoot: "/vendor/vite",
      reader: viteReader
    });
    const wasmAdapterPolicy = actualWasmPolicyPath
      ? createWasmAdapterPolicy(JSON.parse(fs.readFileSync(path.resolve(actualWasmPolicyPath), "utf8")))
      : null;
    const dependencyArtifacts = createViteDependencyArtifactClosureFromWorkspace({
      manager: "pnpm",
      nodeModulesRoot: "/workspace/project/node_modules",
      reader: createDependencyReader(nodeModulesRoot),
      vitePackageArtifact,
      ...(wasmAdapterPolicy ? { wasmAdapterPolicy } : {})
    }).artifacts;
    actualProductContext = {
      dependencyArtifacts,
      nodeModulesRoot,
      vitePackageArtifact,
      vitePackageRoot,
      wasmAdapterPolicy
    };
  } catch (error) {
    actualProductContext = { error };
  }
  return actualProductContext;
}

async function scoreProductActualFixture(fixture) {
  const context = getActualProductContext();
  if (context.error) return blockedActualResult(fixture, "install", context.error);

  const probeWorkflow = createActualProductWorkflow(fixture, context.dependencyArtifacts, context);
  const sourceImport = ensureAndMountFixtureSource(probeWorkflow, fixture);
  const fixtureDependencyResult = sourceImport.ok
    ? createFixtureDependencyArtifacts(fixture, sourceImport.projectDir, context)
    : { artifacts: [], missing: [] };
  const dependencyMerge = mergeViteDependencyArtifacts(context.dependencyArtifacts, fixtureDependencyResult.artifacts);
  const workflow = createActualProductWorkflow(fixture, dependencyMerge.artifacts, context);
  const finalSourceImport = ensureAndMountFixtureSource(workflow, fixture);
  const criteria = [];

  try {
    const install = workflow.install();
    criteria.push(criterion("install", finalSourceImport.ok && install.installed, {
      status: finalSourceImport.ok && install.installed ? 0 : 1,
      stdout: [
        `source import: ${finalSourceImport.summary}`,
        `installed ${install.packages.length} packages`,
        `vite package source ${install.vitePackageSource}`,
        `dependency artifacts ${dependencyMerge.artifacts.length}`,
        `fixture dependency artifacts ${fixtureDependencyResult.artifacts.map((artifact) => artifact.name).join(",") || "none"}`,
        `missing fixture dependency artifacts ${fixtureDependencyResult.missing.join(",") || "none"}`
      ].join("\n"),
      stderr: finalSourceImport.ok ? "" : finalSourceImport.error
    }));
  } catch (error) {
    criteria.push(criterion("install", false, errorResult(error)));
  }

  const devAndHmr = finalSourceImport.ok
    ? await withTimeout(
      runActualDevPreviewAndHmr(workflow, finalSourceImport),
      actualWorkerTimeoutMs + 5000,
      `EACTUALDEVHMRTIMEOUT: actual product dev/HMR scoring did not settle for ${fixture.id}`
    ).catch((error) => ({
      devPreview: errorResult(error),
      editHmr: {
        status: 1,
        stdout: "",
        stderr: "Skipped HMR because actual Vite preview did not settle."
      }
    }))
    : {
      devPreview: { status: 1, stdout: "", stderr: finalSourceImport.error },
      editHmr: { status: 1, stdout: "", stderr: finalSourceImport.error }
    };
  criteria.push(criterion("dev-preview", devAndHmr.devPreview.status === 0, devAndHmr.devPreview));
  criteria.push(criterion("edit-hmr", devAndHmr.editHmr.status === 0, devAndHmr.editHmr));

  try {
    const build = finalSourceImport.ok
      ? await executeActualCli(workflow, ["build"])
      : null;
    const distArtifacts = build ? summarizeWorkspaceDistArtifacts(build.workspaceSnapshot, workflow.projectRoot) : { count: 0, files: [] };
    build?.closeBridgedServers?.();
    criteria.push(criterion("build-dist", Boolean(build && build.exitCode === 0 && distArtifacts.count > 0), {
      status: build && build.exitCode === 0 && distArtifacts.count > 0 ? 0 : 1,
      stdout: build ? `${build.stdout}\ndist artifacts: ${JSON.stringify(distArtifacts)}` : "",
      stderr: build ? build.stderr : finalSourceImport.error || "build did not run"
    }));
  } catch (error) {
    criteria.push(criterion("build-dist", false, errorResult(error)));
  }

  const score = criteria.reduce((total, entry) => total + (entry.status === "pass" ? entry.points : 0), 0);
  return {
    id: fixture.id,
    name: fixture.name,
    mode: "measured-product-actual",
    packageManager: fixture.packageManager,
    repository: fixture.repository,
    subdirectory: fixture.subdirectory || null,
    score,
    status: classifyScore(score, false),
    unsupportedBlocker: false,
    criteria,
    evidence: {
      dependencyArtifactCount: dependencyMerge.artifacts.length,
      fixtureDependencyClosureIterations: fixtureDependencyResult.closureIterations || [],
      fixtureDependencyArtifacts: fixtureDependencyResult.artifacts.map((artifact) => artifact.name),
      importedFiles: finalSourceImport.fileCount || 0,
      missingFixtureDependencyArtifacts: fixtureDependencyResult.missing,
      sourceImport: finalSourceImport.summary,
      vitePackageRoot: context.vitePackageRoot
    }
  };
}

function createActualProductWorkflow(fixture, dependencyArtifacts, context) {
  return new ViteProductWorkflow({
    dependencyArtifacts,
    manager: fixture.packageManager,
    projectId: fixture.id,
    projectRoot: `/workspace/${fixture.id}`,
    ...(context.wasmAdapterPolicy ? { wasmAdapterPolicy: context.wasmAdapterPolicy } : {}),
    vitePackageArtifact: context.vitePackageArtifact
  });
}

function scoreProductAdapterFixture(fixture) {
  const workflow = new ViteProductWorkflow({
    manager: fixture.packageManager,
    projectId: fixture.id,
    projectRoot: `/workspace/${fixture.id}`
  });
  const criteria = [];

  try {
    const install = workflow.install();
    criteria.push(criterion("install", install.installed, {
      status: install.installed ? 0 : 1,
      stdout: `installed ${install.packages.length} packages\nwrote ${install.lockfile}\nvite package source ${install.vitePackageSource}\n`,
      stderr: ""
    }));
  } catch (error) {
    criteria.push(criterion("install", false, errorResult(error)));
  }

  try {
    const build = workflow.buildFromPackageScript();
    criteria.push(criterion("build-dist", build.files.length > 0 && build.distSmoke.includes("<!doctype html>"), {
      status: build.files.length > 0 ? 0 : 1,
      stdout: `emitted ${build.files.join(", ")}\n${build.distSmoke}\n`,
      stderr: ""
    }));
  } catch (error) {
    criteria.push(criterion("build-dist", false, errorResult(error)));
  }

  try {
    const devServer = workflow.startDevServerFromPackageScript();
    const preview = workflow.preview("/");
    criteria.push(criterion("dev-preview", devServer.running && preview.statusCode === 200, {
      status: devServer.running && preview.statusCode === 200 ? 0 : 1,
      stdout: `dev server ${devServer.source} ${devServer.command} on 127.0.0.1:${devServer.port}\n${preview.body}\n`,
      stderr: ""
    }));
  } catch (error) {
    criteria.push(criterion("dev-preview", false, errorResult(error)));
  }

  try {
    const hmr = workflow.editMessage("product-adapter");
    criteria.push(criterion("edit-hmr", hmr.update.updates.length > 0 && hmr.statePreserved, {
      status: hmr.update.updates.length > 0 && hmr.statePreserved ? 0 : 1,
      stdout: `${JSON.stringify(hmr.update)}\n`,
      stderr: ""
    }));
  } catch (error) {
    criteria.push(criterion("edit-hmr", false, errorResult(error)));
  } finally {
    workflow.stopDevServer();
  }

  const score = criteria.reduce((total, entry) => total + (entry.status === "pass" ? entry.points : 0), 0);
  return {
    id: fixture.id,
    name: fixture.name,
    mode: "measured-product-adapter",
    packageManager: fixture.packageManager,
    repository: fixture.repository,
    subdirectory: fixture.subdirectory || null,
    score,
    status: classifyScore(score, false),
    unsupportedBlocker: false,
    criteria
  };
}

function failedResult(fixture, criterionId, result) {
  return {
    id: fixture.id,
    name: fixture.name,
    mode: "measured-reference",
    packageManager: fixture.packageManager,
    repository: fixture.repository,
    subdirectory: fixture.subdirectory || null,
    score: 0,
    status: "partial-pass",
    unsupportedBlocker: false,
    criteria: [
      criterion(criterionId, false, result),
      ...matrix.scoringRubric.criteria
        .filter((entry) => entry.id !== criterionId)
        .map((entry) => ({ id: entry.id, points: entry.points, status: "not-run" }))
    ]
  };
}

function blockedActualResult(fixture, criterionId, error) {
  return {
    id: fixture.id,
    name: fixture.name,
    mode: "measured-product-actual",
    packageManager: fixture.packageManager,
    repository: fixture.repository,
    subdirectory: fixture.subdirectory || null,
    score: 0,
    status: "hold",
    unsupportedBlocker: false,
    criteria: [
      criterion(criterionId, false, errorResult(error)),
      ...matrix.scoringRubric.criteria
        .filter((entry) => entry.id !== criterionId)
        .map((entry) => ({ id: entry.id, points: entry.points, status: "not-run" }))
    ]
  };
}

function ensureAndMountFixtureSource(workflow, fixture) {
  const checkout = path.join(workdir, fixture.id);
  const projectDir = fixture.subdirectory ? path.join(checkout, fixture.subdirectory) : checkout;
  fs.mkdirSync(workdir, { recursive: true });
  if (!fs.existsSync(checkout)) {
    const clone = run("git", ["clone", "--depth", "1", fixture.repository, checkout], workdir);
    if (clone.status !== 0) {
      return {
        ok: false,
        error: `${clone.stderr || clone.stdout || "git clone failed"}`,
        summary: "checkout unavailable"
      };
    }
  }
  if (!fs.existsSync(projectDir)) {
    return {
      ok: false,
      error: `Fixture project directory does not exist: ${projectDir}`,
      summary: "project directory missing"
    };
  }
  return mountProjectDirectory(workflow, projectDir);
}

function mountProjectDirectory(workflow, projectDir) {
  const files = [];
  collectProjectFiles(projectDir, projectDir, files);
  let importedBytes = 0;
  let editablePath = null;
  for (const file of files) {
    const target = `${workflow.projectRoot}/${file.relativePath}`;
    if (file.bytes) workflow.workspace.writeBytes(target, file.bytes);
    else workflow.workspace.writeText(target, file.text);
    importedBytes += file.size;
    if (!editablePath && isEditableSource(file.relativePath)) editablePath = target;
  }
  return {
    ok: true,
    editablePath,
    fileCount: files.length,
    projectDir,
    summary: `imported ${files.length} files from ${projectDir} (${importedBytes} bytes)`
  };
}

function createFixtureDependencyArtifacts(fixture, projectDir, context) {
  const names = readProjectDependencyNames(projectDir);
  if (names.length === 0) return { artifacts: [], missing: [] };
  const nodeModulesRoot = `/workspace/${fixture.id}/node_modules`;
  const reader = createFixtureDependencyReader(projectDir, context.nodeModulesRoot, nodeModulesRoot);
  const directArtifacts = createViteDependencyArtifactsFromWorkspace({
    names,
    nodeModulesRoot,
    reader,
    skipMissing: true
  });
  const closure = createViteDependencyArtifactClosureFromWorkspace({
    initialArtifacts: directArtifacts,
    manager: fixture.packageManager,
    nodeModulesRoot,
    reader,
    vitePackageArtifact: context.vitePackageArtifact,
    ...(context.wasmAdapterPolicy ? { wasmAdapterPolicy: context.wasmAdapterPolicy } : {})
  });
  const found = new Set(directArtifacts.map((artifact) => artifact.name));
  const provided = new Set(defaultProvidedDependencyNames());
  return {
    artifacts: closure.artifacts,
    closureIterations: closure.iterations.map((iteration) => ({
      extracted: iteration.extracted,
      missingCount: iteration.plan.missing.length
    })),
    missing: names.filter((name) => !found.has(name) && !provided.has(name))
  };
}

function defaultProvidedDependencyNames() {
  return ["@vitejs/plugin-react", "react", "react-dom", "typescript", "vite"];
}

function readProjectDependencyNames(projectDir) {
  const manifestPath = path.join(projectDir, "package.json");
  if (!fs.existsSync(manifestPath)) return [];
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  return uniqueNames([
    ...Object.keys(manifest.dependencies || {}),
    ...Object.keys(manifest.devDependencies || {}),
    ...Object.keys(manifest.optionalDependencies || {})
  ]).filter((name) => name !== "vite");
}

function createFixtureDependencyReader(projectDir, fallbackNodeModulesRoot, virtualNodeModulesRoot) {
  const readers = [];
  const fixtureNodeModules = path.join(projectDir, "node_modules");
  if (fs.existsSync(fixtureNodeModules)) {
    readers.push(createNodeFsWorkspaceReader({
      root: fixtureNodeModules,
      virtualRoot: virtualNodeModulesRoot
    }));
    const fixturePnpmHoisted = path.join(fixtureNodeModules, ".pnpm/node_modules");
    if (fs.existsSync(fixturePnpmHoisted)) {
      readers.push(createNodeFsWorkspaceReader({
        root: fixturePnpmHoisted,
        virtualRoot: virtualNodeModulesRoot
      }));
    }
  }
  for (const sharedRoot of discoverSharedFixtureNodeModulesRoots()) {
    if (sharedRoot === fixtureNodeModules) continue;
    readers.push(createNodeFsWorkspaceReader({
      root: sharedRoot,
      virtualRoot: virtualNodeModulesRoot
    }));
    const sharedPnpmHoisted = path.join(sharedRoot, ".pnpm/node_modules");
    if (fs.existsSync(sharedPnpmHoisted)) {
      readers.push(createNodeFsWorkspaceReader({
        root: sharedPnpmHoisted,
        virtualRoot: virtualNodeModulesRoot
      }));
    }
  }
  readers.push(createNodeFsWorkspaceReader({
    root: fallbackNodeModulesRoot,
    virtualRoot: virtualNodeModulesRoot
  }));
  const fallbackPnpmHoisted = path.join(fallbackNodeModulesRoot, ".pnpm/node_modules");
  if (fs.existsSync(fallbackPnpmHoisted)) {
    readers.push(createNodeFsWorkspaceReader({
      root: fallbackPnpmHoisted,
      virtualRoot: virtualNodeModulesRoot
    }));
  }
  return createFallbackWorkspaceReader(readers);
}

function discoverSharedFixtureNodeModulesRoots() {
  if (!useSharedFixtureNodeModules) return [];
  const roots = [];
  for (const fixture of matrix.fixtures) {
    const checkout = path.join(workdir, fixture.id);
    const candidates = [
      fixture.subdirectory ? path.join(checkout, fixture.subdirectory, "node_modules") : null,
      path.join(checkout, "node_modules")
    ].filter(Boolean);
    for (const candidate of candidates) {
      if (fs.existsSync(candidate) && !roots.includes(candidate)) roots.push(candidate);
    }
  }
  return roots;
}

function collectProjectFiles(rootDir, currentDir, files) {
  if (files.length >= 1000) return;
  for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
    if (shouldSkipProjectEntry(entry.name)) continue;
    const absolute = path.join(currentDir, entry.name);
    const relativePath = path.relative(rootDir, absolute).replaceAll(path.sep, "/");
    if (entry.isDirectory()) {
      collectProjectFiles(rootDir, absolute, files);
      continue;
    }
    if (!entry.isFile()) continue;
    const stat = fs.statSync(absolute);
    if (stat.size > 1024 * 1024) continue;
    const bytes = fs.readFileSync(absolute);
    if (isLikelyText(bytes)) {
      files.push({ relativePath, size: stat.size, text: bytes.toString("utf8") });
    } else {
      files.push({ bytes, relativePath, size: stat.size });
    }
  }
}

function shouldSkipProjectEntry(name) {
  return new Set([
    ".git",
    ".next",
    ".turbo",
    "coverage",
    "dist",
    "node_modules"
  ]).has(name);
}

function isLikelyText(bytes) {
  return !bytes.subarray(0, Math.min(bytes.length, 4096)).includes(0);
}

function isEditableSource(relativePath) {
  return /(^|\/)src\/.*\.[cm]?[jt]sx?$/.test(relativePath) || /(^|\/)app\/.*\.[cm]?[jt]sx?$/.test(relativePath);
}

async function runActualDevPreviewAndHmr(workflow, sourceImport) {
  let execution = null;
  try {
    execution = await executeActualCli(workflow, ["--host", "127.0.0.1"]);
    const preview = await fetchWorkflowPath(workflow, "/");
    const devPreview = {
      status: execution.exitCode === 0 && preview.status === 200 ? 0 : 1,
      stdout: `${execution.stdout}\npreview status: ${preview.status}\n${preview.bodyStart || ""}`,
      stderr: execution.stderr || preview.error || ""
    };
    const editHmr = await runActualHmrEdit(workflow, execution, sourceImport.editablePath);
    return { devPreview, editHmr };
  } catch (error) {
    return {
      devPreview: errorResult(error),
      editHmr: {
        status: 1,
        stdout: "",
        stderr: "Skipped HMR because actual Vite preview did not start."
      }
    };
  } finally {
    execution?.closeBridgedServers?.();
  }
}

async function runActualHmrEdit(workflow, execution, editablePath) {
  if (!editablePath) {
    return {
      status: 1,
      stdout: "",
      stderr: "No editable source candidate found."
    };
  }
  if (!execution.writeBridgedFile) {
    return {
      status: 1,
      stdout: "",
      stderr: "HMR edit bridge is unavailable."
    };
  }
  const relative = editablePath.slice(`${workflow.projectRoot}/`.length);
  const original = workflow.workspace.readText(editablePath);
  const marker = `\n// cargo-container-product-actual-hmr-${Date.now()}\n`;
  const messages = [];
  let socket = null;
  try {
    await fetchWorkflowPath(workflow, `/${relative}`);
    socket = workflow.network.connectWebSocket("ws://127.0.0.1:5173/", { protocol: "vite-hmr" });
    socket.onmessage = (event) => messages.push(String(event.data));
    await new Promise((resolve) => setTimeout(resolve, 50));
    const write = await execution.writeBridgedFile(editablePath, `${original}${marker}`);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const messageTypes = messages.map((message) => parseHmrMessageType(message));
    const passed = messageTypes.some((type) => type === "update" || type === "full-reload");
    return {
      status: passed ? 0 : 1,
      stdout: [
        `edited ${relative}`,
        `watcher count: ${write.watcherCount ?? "unknown"}`,
        `messages: ${messageTypes.join(",") || "none"}`
      ].join("\n"),
      stderr: passed ? "" : "HMR update was not observed after source edit."
    };
  } catch (error) {
    return errorResult(error);
  } finally {
    socket?.close();
    if (execution.writeBridgedFile) {
      try {
        await execution.writeBridgedFile(editablePath, original);
      } catch {
        // Best-effort cleanup inside the worker-backed VFS.
      }
    }
  }
}

async function fetchWorkflowPath(workflow, requestPath) {
  try {
    const response = await workflow.fetch(`http://127.0.0.1:5173${requestPath}`, {
      headers: headersForFetchPath(requestPath)
    });
    return {
      bodyStart: (await response.text()).slice(0, 500),
      status: response.status
    };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error),
      status: null
    };
  }
}

function workerCliOptions() {
  return {
    isolation: "worker",
    readyTimeoutMs: 1000,
    workerFactory: () => new NodeThreadCliEvaluationWorker(),
    workerTimeoutMs: actualWorkerTimeoutMs
  };
}

function executeActualCli(workflow, args) {
  const timeoutMs = actualWorkerTimeoutMs + 5000;
  let timeout = null;
  const execution = workflow.executeRealCli(args, {}, workerCliOptions());
  const guard = new Promise((_, reject) => {
    timeout = setTimeout(() => {
      reject(new Error(`EACTUALCLITIMEOUT: actual product CLI scoring did not settle within ${timeoutMs}ms for ${args.join(" ")}`));
    }, timeoutMs);
  });
  return Promise.race([execution, guard]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
}

function withTimeout(promise, timeoutMs, message) {
  let timeout = null;
  const guard = new Promise((_, reject) => {
    timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, guard]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
}

function summarizeWorkspaceDistArtifacts(snapshot, projectRoot) {
  const prefix = `${projectRoot}/dist/`;
  const files = (snapshot?.files || [])
    .filter((file) => file.path.startsWith(prefix))
    .map((file) => ({
      path: file.path.slice(projectRoot.length + 1),
      size: String(file.data || "").length
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
  return {
    count: files.length,
    files
  };
}

function parseHmrMessageType(message) {
  try {
    return JSON.parse(message).type || null;
  } catch {
    return null;
  }
}

function uniqueNames(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value.length > 0))].sort();
}

function createDependencyReader(nodeModulesRoot) {
  const readers = [createNodeFsWorkspaceReader({
    root: nodeModulesRoot,
    virtualRoot: "/workspace/project/node_modules"
  })];
  const pnpmHoistedRoot = path.join(nodeModulesRoot, ".pnpm/node_modules");
  if (fs.existsSync(pnpmHoistedRoot)) {
    readers.push(createNodeFsWorkspaceReader({
      root: pnpmHoistedRoot,
      virtualRoot: "/workspace/project/node_modules"
    }));
  }
  return createFallbackWorkspaceReader(readers);
}

function criterion(id, passed, result) {
  const spec = matrix.scoringRubric.criteria.find((entry) => entry.id === id);
  return {
    id,
    points: spec?.points || 0,
    status: passed ? "pass" : "fail",
    exitCode: result.status,
    ...(!passed ? { failureCategory: classifyFailure(id, result) } : {}),
    stdoutTail: tail(result.stdout),
    stderrTail: tail(result.stderr)
  };
}

function summarize(results) {
  const passCount = results.filter((result) => result.status === "pass").length;
  return {
    total: results.length,
    passCount,
    milestoneB: passCount >= matrix.scope.minimumPassForMilestoneB ? "pass" : "not-yet"
  };
}

function classifyScore(score, unsupportedBlocker) {
  if (unsupportedBlocker) return "unsupported";
  if (score >= 80) return "pass";
  if (score >= 50) return "partial-pass";
  return "hold";
}

function summarizeFailures(results) {
  const counts = {};
  for (const result of results) {
    for (const entry of result.criteria) {
      if (entry.status !== "fail") continue;
      const category = entry.failureCategory || "unclassified";
      counts[category] = (counts[category] || 0) + 1;
    }
  }
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}

function classifyFailure(id, result) {
  const text = `${result.stdout || ""}\n${result.stderr || ""}`.toLowerCase();
  if (text.includes("err_pnpm_ignored_builds")) return "package-manager-ignored-build-scripts";
  if (text.includes("preview did not become ready") || text.includes("preview returned http")) return "dev-preview-unavailable";
  if (id === "edit-hmr" && text.includes("skipped hmr")) return "dev-preview-unavailable";
  if (id === "edit-hmr" && text.includes("hmr socket failed")) return "hmr-socket-connect-failed";
  if (id === "edit-hmr" && text.includes("hmr socket did not open")) return "hmr-socket-connect-failed";
  if (id === "edit-hmr" && text.includes("hmr update was not observed")) return "hmr-update-timeout";
  if (id === "edit-hmr" && text.includes("no editable source")) return "hmr-edit-source-missing";
  if (text.includes("native addon")) return "native-addon-unsupported";
  return `${id}-command-failed`;
}

function runCommandString(command, cwd) {
  const [bin, ...argv] = command.split(/\s+/).filter(Boolean);
  if (!bin) throw new Error(`empty command for ${cwd}`);
  return run(bin, argv, cwd);
}

function run(bin, argv, cwd) {
  return spawnSync(bin, argv, {
    cwd,
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 10,
    shell: false
  });
}

function errorResult(error) {
  return {
    status: 1,
    stdout: "",
    stderr: error instanceof Error ? error.stack || error.message : String(error)
  };
}

async function runDevPreviewAndHmr(command, cwd) {
  const [bin, ...argv] = command.split(/\s+/).filter(Boolean);
  if (!bin) throw new Error(`empty dev command for ${cwd}`);
  const child = spawn(bin, argv, {
    cwd,
    detached: process.platform !== "win32",
    env: {
      ...process.env,
      BROWSER: "none",
      CI: "true",
      HOST: "127.0.0.1",
      PORT: "5173"
    },
    shell: false
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  try {
    const response = await waitForPreview(() => firstPreviewUrl(stdout, stderr) || "http://127.0.0.1:5173/");
    const previewUrl = firstPreviewUrl(stdout, stderr) || "http://127.0.0.1:5173/";
    const editHmr = response.ok
      ? await runEditHmr(previewUrl, cwd)
      : { status: 1, stdout: "", stderr: `preview returned HTTP ${response.status}` };
    return {
      devPreview: {
        status: response.ok ? 0 : 1,
        stdout,
        stderr: response.ok ? stderr : `${stderr}\npreview returned HTTP ${response.status}`
      },
      editHmr
    };
  } catch (error) {
    return {
      devPreview: {
        status: 1,
        stdout,
        stderr: `${stderr}\n${error instanceof Error ? error.message : String(error)}`
      },
      editHmr: {
        status: 1,
        stdout: "",
        stderr: "Skipped HMR because preview did not become ready."
      }
    };
  } finally {
    await stopChildProcess(child);
  }
}

async function runEditHmr(previewUrl, cwd) {
  const target = findEditableSource(cwd);
  if (!target) {
    return {
      status: 1,
      stdout: "",
      stderr: "No editable source candidate found."
    };
  }
  const original = fs.readFileSync(target, "utf8");
  const marker = `\n// cargo-container-hmr-${Date.now()}\n`;
  const hmrUrl = await resolveHmrUrl(previewUrl);
  const moduleUrl = sourceModuleUrl(previewUrl, path.relative(cwd, target));
  let socket;
  try {
    await fetch(moduleUrl);
    socket = await connectHmrSocket(hmrUrl);
    const update = waitForHmrUpdate(socket);
    fs.writeFileSync(target, `${original}${marker}`);
    const message = await update;
    return {
      status: 0,
      stdout: `edited ${path.relative(cwd, target)}\n${message}`,
      stderr: ""
    };
  } catch (error) {
    return {
      status: 1,
      stdout: `edited ${path.relative(cwd, target)}`,
      stderr: error instanceof Error ? error.message : String(error)
    };
  } finally {
    fs.writeFileSync(target, original);
    socket?.close();
  }
}

async function stopChildProcess(child) {
  if (child.exitCode !== null || child.signalCode) return;
  killChildProcess(child, "SIGTERM");
  const exited = await waitForExit(child, 1000);
  if (exited) return;
  killChildProcess(child, "SIGKILL");
  await waitForExit(child, 1000);
}

function killChildProcess(child, signal) {
  try {
    if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    child.kill(signal);
  }
}

function waitForExit(child, timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

async function waitForPreview(urlProvider) {
  const deadline = Date.now() + 15000;
  let lastError = null;
  while (Date.now() < deadline) {
    const url = urlProvider();
    try {
      const response = await fetch(url);
      if (response.status < 500) return response;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`preview did not become ready: ${lastError instanceof Error ? lastError.message : "timeout"}`);
}

function firstPreviewUrl(stdout, stderr) {
  const match = `${stdout}\n${stderr}`.match(/https?:\/\/(?:localhost|127\.0\.0\.1):\d+\/?/);
  return match?.[0] || null;
}

function findEditableSource(cwd) {
  const candidates = [
    "src/App.jsx",
    "src/App.tsx",
    "src/App.js",
    "src/App.ts",
    "src/main.jsx",
    "src/main.tsx",
    "src/main.js",
    "src/main.ts"
  ];
  return candidates.map((candidate) => path.join(cwd, candidate)).find((candidate) => fs.existsSync(candidate)) || null;
}

function sourceModuleUrl(previewUrl, relativePath) {
  const url = new URL(relativePath.replaceAll("\\", "/"), previewUrl);
  url.searchParams.set("t", String(Date.now()));
  return url.href;
}

async function resolveHmrUrl(previewUrl) {
  const parsed = new URL(previewUrl);
  const clientUrl = new URL("/@vite/client", parsed);
  try {
    const source = await fetch(clientUrl).then((response) => response.ok ? response.text() : "");
    return resolveViteHmrUrl({ previewUrl, clientSource: source }).url;
  } catch {
    return resolveViteHmrUrl({ previewUrl }).url;
  }
}

function connectHmrSocket(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, "vite-hmr");
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error(`HMR socket did not open: ${url}`));
    }, 5000);
    socket.addEventListener("open", () => {
      clearTimeout(timeout);
      resolve(socket);
    }, { once: true });
    socket.addEventListener("error", () => {
      clearTimeout(timeout);
      reject(new Error(`HMR socket failed: ${url}`));
    }, { once: true });
  });
}

function waitForHmrUpdate(socket) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("HMR update was not observed after source edit.")), 10000);
    socket.addEventListener("message", (event) => {
      const data = String(event.data);
      if (!data.includes("\"update\"")) return;
      clearTimeout(timeout);
      resolve(data);
    });
  });
}

function tail(value = "") {
  const lines = value.split(/\r?\n/).filter(Boolean);
  return lines.slice(-20).join("\n");
}

function defaultOutputForMode(scoreMode) {
  if (scoreMode === "product-adapter") return "compat/ecosystem-fixture-product-results.json";
  if (scoreMode === "product-actual") return "compat/ecosystem-fixture-actual-product-results.json";
  return "compat/ecosystem-fixture-results.json";
}

function valueAfter(name) {
  const prefix = `${name}=`;
  const values = process.argv.slice(2);
  const inline = values.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = values.indexOf(name);
  if (index < 0) return undefined;
  const value = values[index + 1];
  return value && !value.startsWith("--") ? value : undefined;
}
