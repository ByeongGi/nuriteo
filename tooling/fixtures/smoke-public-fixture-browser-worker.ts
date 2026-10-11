#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { chromium } from "@playwright/test";
import { createServer } from "vite";
import { REQUIRED_RUNTIME_HEADERS } from "../../packages/browser-host/src/security/headers.ts";
import {
  createViteDependencyArtifactClosureFromWorkspace,
  createVitePackageArtifactFromWorkspace,
  ViteProductWorkflow
} from "../../packages/node-runtime/src/frameworks/vite-workflow.ts";
import { createFallbackWorkspaceReader, createNodeFsWorkspaceReader } from "../shared/fs-workspace-reader.ts";

const root = path.resolve(new URL("../..", import.meta.url).pathname);
const resultsPath = path.join(root, "compat/public-fixture-browser-worker-results.json");
if (!process.env.NURITEO_FIXTURE_PREP_ROOT) throw new Error("NURITEO_FIXTURE_PREP_ROOT is required; run the pinned public fixture preparation workflow first");
const preparedRoot = path.resolve(process.env.NURITEO_FIXTURE_PREP_ROOT);
const fixtureId = "vite-official-template-react";
const revision = "1544bb1b7ac92f775e9d0dea97954c99cc6cbd43";
const checkout = path.join(preparedRoot, "fixtures", fixtureId);
const sourceRoot = path.join(checkout, "packages/create-vite/template-react");
const viteRoot = path.join(preparedRoot, "toolchain/node_modules/vite");
const nodeModulesRoot = path.join(preparedRoot, "toolchain/node_modules");
const chromePath = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { cwd: checkout, encoding: "utf8" }).trim(), revision);
assert.equal(JSON.parse(fs.readFileSync(path.join(viteRoot, "package.json"), "utf8")).version, "8.2.0");

const projectRoot = "/workspace/project";
const vitePackageArtifact = createVitePackageArtifactFromWorkspace({
  packageRoot: "/vendor/vite",
  reader: createNodeFsWorkspaceReader({ root: viteRoot, virtualRoot: "/vendor/vite" })
});
const readers = [createNodeFsWorkspaceReader({ root: nodeModulesRoot, virtualRoot: "/workspace/project/node_modules" })];
const pnpmHoistedRoot = path.join(nodeModulesRoot, ".pnpm/node_modules");
if (fs.existsSync(pnpmHoistedRoot)) readers.push(createNodeFsWorkspaceReader({ root: pnpmHoistedRoot, virtualRoot: "/workspace/project/node_modules" }));
const dependencyArtifacts = createViteDependencyArtifactClosureFromWorkspace({
  manager: "pnpm",
  nodeModulesRoot: "/workspace/project/node_modules",
  reader: createFallbackWorkspaceReader(readers),
  vitePackageArtifact
}).artifacts;
const workflow = new ViteProductWorkflow({
  dependencyArtifacts,
  manager: "pnpm",
  projectId: fixtureId,
  projectRoot,
  vitePackageArtifact
});
const workspace = workflow.workspace;
const mountedFixtureFiles = walkRelativeFiles(sourceRoot);
for (const relative of mountedFixtureFiles) {
  workspace.writeBytes(`${projectRoot}/${relative}`, fs.readFileSync(path.join(sourceRoot, relative)));
}
workflow.install();
const initialSnapshot = workspace.snapshot();
const editedAppSource = workspace.readText(`${projectRoot}/src/App.jsx`).replace("Count is {count}", "Browser HMR count is {count}");

const server = await createServer({
  root,
  publicDir: path.join(root, "packages/workspace-runtime/assets"),
  configFile: false,
  server: { host: "127.0.0.1", port: 0 },
  plugins: [{
    name: "public-fixture-worker-security-headers",
    configureServer(vite) {
      vite.middlewares.use((request, response, next) => {
        response.setHeader("Cross-Origin-Opener-Policy", REQUIRED_RUNTIME_HEADERS.coop);
        response.setHeader("Cross-Origin-Embedder-Policy", REQUIRED_RUNTIME_HEADERS.coep);
        response.setHeader("Content-Security-Policy", REQUIRED_RUNTIME_HEADERS.csp);
        if (request.url === "/public-fixture-worker-smoke") {
          response.setHeader("Content-Type", "text/html");
          response.end("<!doctype html><html><body>Public fixture worker smoke</body></html>");
          return;
        }
        next();
      });
    }
  }]
});

await server.listen();
const browser = await chromium.launch({ headless: true, executablePath: chromePath });
try {
  const page = await browser.newPage();
  const origin = server.resolvedUrls.local[0];
  const documentResponse = await page.goto(`${origin}public-fixture-worker-smoke`, { waitUntil: "load" });
  assert.equal(documentResponse.headers()["content-security-policy"], REQUIRED_RUNTIME_HEADERS.csp);
  assert.equal(documentResponse.headers()["cross-origin-opener-policy"], REQUIRED_RUNTIME_HEADERS.coop);
  assert.equal(documentResponse.headers()["cross-origin-embedder-policy"], REQUIRED_RUNTIME_HEADERS.coep);
  const workerHeaders = await page.evaluate(async () => {
    const response = await fetch("/workers/process-worker.ts");
    return {
      csp: response.headers.get("content-security-policy"),
      coop: response.headers.get("cross-origin-opener-policy"),
      coep: response.headers.get("cross-origin-embedder-policy"),
      isolated: globalThis.crossOriginIsolated
    };
  });
  assert.deepEqual(workerHeaders, {
    csp: REQUIRED_RUNTIME_HEADERS.csp,
    coop: REQUIRED_RUNTIME_HEADERS.coop,
    coep: REQUIRED_RUNTIME_HEADERS.coep,
    isolated: true
  });

  const browserCdp = await browser.newBrowserCDPSession();
  const workerTargetsBefore = await processWorkerTargetCount(browserCdp);
  const dev = await page.evaluate(async ({ editedAppSource, projectRoot, snapshot }) => {
      const worker = new Worker("/workers/process-worker.ts", { type: "module" });
      const pending = [];
      const waiters = [];
      worker.addEventListener("message", (event) => {
        const waiterIndex = waiters.findIndex((waiter) => waiter.predicate(event.data));
        if (waiterIndex >= 0) {
          const [waiter] = waiters.splice(waiterIndex, 1);
          clearTimeout(waiter.timeout);
          waiter.resolve(event.data);
        } else {
          pending.push(event.data);
        }
      });
      const waitFor = (predicate, timeoutMs = 30000) => {
        const pendingIndex = pending.findIndex(predicate);
        if (pendingIndex >= 0) return Promise.resolve(pending.splice(pendingIndex, 1)[0]);
        return new Promise((resolve, reject) => {
          const timeout = setTimeout(() => {
            const index = waiters.findIndex((waiter) => waiter.resolve === resolve);
            if (index >= 0) waiters.splice(index, 1);
            reject(new Error("Public fixture worker message timed out"));
          }, timeoutMs);
          waiters.push({ predicate, reject, resolve, timeout });
        });
      };
      const request = async (port, requestId, requestPath) => {
        worker.postMessage({
          evaluationId: 1,
          id: requestId,
          port,
          request: { headers: {}, method: "GET", path: requestPath },
          type: "cli:http:request"
        });
        const response = await waitFor((message) => message?.type === "cli:http:response" && message.id === requestId);
        if (response.error) throw new Error(response.error);
        const body = typeof response.response?.body === "string"
          ? response.response.body
          : new TextDecoder().decode(response.response?.body || new Uint8Array());
        return { body, statusCode: response.response?.statusCode ?? 0 };
      };
      try {
        worker.postMessage({
          bridgeLoopbackServer: true,
          id: 1,
          readyTimeoutMs: 30000,
          root: "/workspace",
          settleTicks: 12,
          settleTimeoutMs: 3000,
          type: "cli:evaluate",
          request: {
            args: ["--host", "127.0.0.1"],
            cwd: projectRoot,
            entry: { name: "vite", version: "8.2.0", mode: "esm", entry: `${projectRoot}/node_modules/vite/bin/vite.js` }
          },
          workspaceSnapshot: snapshot
        });
        const resultMessage = await waitFor((message) => message?.type === "cli:result" && message.id === 1, 60000);
        if (resultMessage.error) throw new Error(resultMessage.error);
        const port = resultMessage.result?.bridgedServerPorts?.[0];
        if (!port) {
          const generatedConfig = resultMessage.result?.workspaceSnapshot?.files?.find((file) => file.path.includes("/.vite-temp/"));
          const generatedSource = generatedConfig ? atob(generatedConfig.data).slice(0, 2000) : "<missing generated config>";
          throw new Error(`Vite dev returned no bridged port: ${resultMessage.result?.stderr || "<no stderr>"}\n${generatedSource}`);
        }
        const index = await request(port, 10, "/");
        const beforeEdit = await request(port, 11, "/src/App.jsx");
        worker.postMessage({
          evaluationId: 1,
          headers: {},
          id: 13,
          path: "/",
          port,
          protocol: "vite-hmr",
          type: "cli:ws:connect"
        });
        const connected = await waitFor((message) => {
          if (message?.type !== "cli:ws:message" || message.id !== 13) return false;
          try { return JSON.parse(message.data)?.type === "connected"; } catch { return false; }
        });
        worker.postMessage({
          data: editedAppSource,
          evaluationId: 1,
          id: 20,
          path: `${projectRoot}/src/App.jsx`,
          type: "cli:fs:write"
        });
        const write = await waitFor((message) => message?.type === "cli:fs:write:result" && message.id === 20, 30000);
        if (write.error) throw new Error(write.error);
        const update = await waitFor((message) => {
          if (message?.type !== "cli:ws:message" || message.id !== 13) return false;
          try {
            const payload = JSON.parse(message.data);
            return payload?.type === "update" || payload?.type === "full-reload";
          } catch {
            return false;
          }
        });
        const afterEdit = await request(port, 12, "/src/App.jsx?t=browser-hmr");
        return {
          exitCode: resultMessage.result?.exitCode,
          index,
          beforeEdit,
          afterEdit,
          hmr: write.result,
          hmrConnected: JSON.parse(connected.data).type === "connected",
          hmrUpdateType: JSON.parse(update.data).type,
          port,
          stderr: resultMessage.result?.stderr || "",
          stdout: resultMessage.result?.stdout || ""
        };
      } finally {
        worker.terminate();
      }
    }, { editedAppSource, projectRoot, snapshot: initialSnapshot });

  await waitForWorkerTargets(browserCdp, workerTargetsBefore);
  const build = await page.evaluate(async ({ projectRoot, snapshot }) => {
    const worker = new Worker("/workers/process-worker.ts", { type: "module" });
    try {
      const message = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Vite build worker timed out")), 60000);
        worker.addEventListener("message", (event) => {
          if (event.data?.type !== "cli:result" || event.data.id !== 2) return;
          clearTimeout(timeout);
          resolve(event.data);
        });
        worker.addEventListener("error", (event) => {
          clearTimeout(timeout);
          reject(new Error(event.message));
        });
        worker.postMessage({
          exitTimeoutMs: 45000,
          id: 2,
          readyTimeoutMs: 30000,
          request: {
            args: ["build", "--minify=false"],
            cwd: projectRoot,
            entry: { name: "vite", version: "8.2.0", mode: "esm", entry: `${projectRoot}/node_modules/vite/bin/vite.js` }
          },
          root: "/workspace",
          settleTicks: 12,
          settleTimeoutMs: 100,
          type: "cli:evaluate",
          workspaceSnapshot: snapshot
        });
      });
      if (message.error) throw new Error(message.error);
      const distFiles = message.result.workspaceSnapshot.files
        .filter((file) => file.path.startsWith(`${projectRoot}/dist/`))
        .map((file) => ({ bytes: atob(file.data).length, path: file.path }));
      return {
        distFiles,
        exitCode: message.result.exitCode,
        stderr: message.result.stderr || "",
        stdout: message.result.stdout || "",
        workspaceSnapshot: message.result.workspaceSnapshot
      };
    } finally {
      worker.terminate();
    }
  }, { projectRoot, snapshot: initialSnapshot });

  await waitForWorkerTargets(browserCdp, workerTargetsBefore);
  assert.ok(build.distFiles.length > 0, `Vite build produced no dist files\n${build.stdout}\n${build.stderr}`);
  const preview = await page.evaluate(async ({ projectRoot, snapshot }) => {
    const worker = new Worker("/workers/process-worker.ts", { type: "module" });
    try {
      const resultMessage = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Vite preview worker timed out")), 60000);
        worker.addEventListener("message", (event) => {
          if (event.data?.type !== "cli:result" || event.data.id !== 3) return;
          clearTimeout(timeout);
          resolve(event.data);
        });
        worker.addEventListener("error", (event) => {
          clearTimeout(timeout);
          reject(new Error(event.message));
        });
        worker.postMessage({
          bridgeLoopbackServer: true,
          id: 3,
          readyTimeoutMs: 30000,
          request: {
            args: ["preview", "--host", "127.0.0.1"],
            cwd: projectRoot,
            entry: { name: "vite", version: "8.2.0", mode: "esm", entry: `${projectRoot}/node_modules/vite/bin/vite.js` }
          },
          root: "/workspace",
          settleTicks: 12,
          settleTimeoutMs: 3000,
          type: "cli:evaluate",
          workspaceSnapshot: snapshot
        });
      });
      if (resultMessage.error) throw new Error(resultMessage.error);
      const port = resultMessage.result?.bridgedServerPorts?.[0];
      if (!port) throw new Error(`Vite preview returned no bridged port: ${resultMessage.result?.stderr || "<no stderr>"}`);
      worker.postMessage({
        evaluationId: 3,
        id: 30,
        port,
        request: { headers: {}, method: "GET", path: "/" },
        type: "cli:http:request"
      });
      const responseMessage = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Vite preview response timed out")), 30000);
        worker.addEventListener("message", (event) => {
          if (event.data?.type !== "cli:http:response" || event.data.id !== 30) return;
          clearTimeout(timeout);
          resolve(event.data);
        });
      });
      if (responseMessage.error) throw new Error(responseMessage.error);
      const body = typeof responseMessage.response?.body === "string"
        ? responseMessage.response.body
        : new TextDecoder().decode(responseMessage.response?.body || new Uint8Array());
      return {
        body,
        exitCode: resultMessage.result?.exitCode,
        port,
        statusCode: responseMessage.response?.statusCode ?? 0,
        stderr: resultMessage.result?.stderr || ""
      };
    } finally {
      worker.terminate();
    }
  }, { projectRoot, snapshot: build.workspaceSnapshot });

  await waitForWorkerTargets(browserCdp, workerTargetsBefore);
  const workerTargetsAfter = await processWorkerTargetCount(browserCdp);

  const observed = {
    schemaVersion: 1,
    status: "pass",
    fixtureId,
    revision,
    viteVersion: "8.2.0",
    dependencyArtifactCount: dependencyArtifacts.length,
    mountedFixtureFileCount: mountedFixtureFiles.length,
    executionHost: "strict-csp-chrome-process-worker",
    headers: workerHeaders,
    install: { dependencyArtifactCount: dependencyArtifacts.length, status: "pass" },
    dev: {
      exitCode: dev.exitCode,
      indexStatus: dev.index.statusCode,
      port: dev.port,
      sourceStatus: dev.beforeEdit.statusCode
    },
    hmr: {
      afterEditContainsMarker: dev.afterEdit.body.includes("Browser HMR count"),
      beforeEditContainsMarker: dev.beforeEdit.body.includes("Browser HMR count"),
      connected: dev.hmrConnected,
      statWatcherCount: dev.hmr.statWatcherCount,
      updateType: dev.hmrUpdateType,
      watcherCount: dev.hmr.watcherCount
    },
    build: { distFiles: build.distFiles, exitCode: build.exitCode },
    preview: { exitCode: preview.exitCode, port: preview.port, statusCode: preview.statusCode },
    lifecycle: { workerTargetsAfter, workerTargetsBefore, restartable: preview.statusCode === 200 }
  };
  assert.equal(observed.dev.exitCode, 0);
  assert.equal(observed.dev.indexStatus, 200);
  assert.equal(observed.dev.sourceStatus, 200);
  assert.equal(observed.hmr.beforeEditContainsMarker, false);
  assert.equal(observed.hmr.afterEditContainsMarker, true);
  assert.equal(observed.hmr.connected, true);
  assert.ok(observed.hmr.updateType === "update" || observed.hmr.updateType === "full-reload");
  assert.ok(observed.hmr.watcherCount > 0 || observed.hmr.statWatcherCount > 0);
  assert.equal(observed.build.exitCode, 0, `${build.stdout}\n${build.stderr}`);
  assert.ok(observed.build.distFiles.some((file) => file.path.endsWith("/dist/index.html") && file.bytes > 0));
  assert.ok(observed.build.distFiles.some((file) => file.path.includes("/dist/assets/") && file.bytes > 0));
  assert.equal(observed.preview.exitCode, 0);
  assert.equal(observed.preview.statusCode, 200);
  assert.match(preview.body, /<script\b[^>]*type=["']module["']/i);
  assert.equal(observed.lifecycle.workerTargetsAfter, observed.lifecycle.workerTargetsBefore);
  assert.equal(observed.lifecycle.restartable, true);
  const serialized = `${JSON.stringify(observed, null, 2)}\n`;
  if (process.argv.includes("--write-results")) fs.writeFileSync(resultsPath, serialized);
  process.stdout.write(serialized);
} finally {
  await browser.close();
  await server.close();
}

function walkRelativeFiles(directory, relative = "") {
  const files = [];
  for (const entry of fs.readdirSync(path.join(directory, relative), { withFileTypes: true })) {
    if (!relative && entry.name === "node_modules") continue;
    const child = path.posix.join(relative, entry.name);
    if (entry.isDirectory() || (entry.isSymbolicLink() && fs.statSync(path.join(directory, child)).isDirectory())) files.push(...walkRelativeFiles(directory, child));
    else files.push(child);
  }
  return files.sort();
}

async function processWorkerTargetCount(cdp) {
  const { targetInfos } = await cdp.send("Target.getTargets");
  return targetInfos.filter((target) => target.type === "worker" && (
    target.url.includes("process-worker") ||
    target.url.includes("wasi-worker-browser")
  )).length;
}

async function waitForWorkerTargets(cdp, expected) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (await processWorkerTargetCount(cdp) === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(await processWorkerTargetCount(cdp), expected, "process/WASI workers leaked after termination");
}
