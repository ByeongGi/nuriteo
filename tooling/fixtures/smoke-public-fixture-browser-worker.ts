#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { chromium } from "@playwright/test";
import { createServer } from "../../apps/preview-service/node_modules/vite/dist/node/index.js";
import { REQUIRED_RUNTIME_HEADERS } from "../../packages/browser-host/src/security/headers.ts";
import {
  createViteDependencyArtifactClosureFromWorkspace,
  createVitePackageArtifactFromWorkspace,
  ViteProductWorkflow
} from "../../packages/node-runtime/src/frameworks/vite-workflow.ts";
import { createFallbackWorkspaceReader, createNodeFsWorkspaceReader } from "../shared/fs-workspace-reader.ts";

const root = path.resolve(new URL("../..", import.meta.url).pathname);
if (!process.env.CARGO_FIXTURE_PREP_ROOT) throw new Error("CARGO_FIXTURE_PREP_ROOT is required; run the pinned public fixture preparation workflow first");
const preparedRoot = path.resolve(process.env.CARGO_FIXTURE_PREP_ROOT);
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
for (const relative of ["package.json", "index.html", "vite.config.js", "src/App.jsx", "src/main.jsx"]) {
  workspace.writeBytes(`${projectRoot}/${relative}`, fs.readFileSync(path.join(sourceRoot, relative)));
}
workflow.install();

const server = await createServer({
  root,
  publicDir: path.join(root, "apps/preview-service/public"),
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

  const attempts = [];
  for (const args of [["--host", "127.0.0.1"], ["build"]]) {
    const result = await page.evaluate(async ({ args, projectRoot, snapshot }) => {
      const worker = new Worker("/workers/process-worker.ts", { type: "module" });
      try {
        return await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error("Public fixture worker timed out")), 20000);
          worker.addEventListener("message", (event) => {
            if (event.data?.type !== "cli:result") return;
            clearTimeout(timeout);
            resolve(event.data);
          });
          worker.addEventListener("error", (event) => {
            clearTimeout(timeout);
            reject(new Error(event.message));
          });
          worker.postMessage({
            id: 1,
            type: "cli:evaluate",
            root: "/workspace",
            request: {
              args,
              cwd: projectRoot,
              entry: { name: "vite", version: "8.2.0", mode: "esm", entry: `${projectRoot}/node_modules/vite/bin/vite.js` }
            },
            workspaceSnapshot: snapshot
          });
        });
      } finally {
        worker.terminate();
      }
    }, { args, projectRoot, snapshot: workspace.snapshot() });
    attempts.push({ command: args[0] === "build" ? "build" : "dev", result });
  }

  const observed = {
    schemaVersion: 1,
    status: "hold",
    fixtureId,
    revision,
    viteVersion: "8.2.0",
    dependencyArtifactCount: dependencyArtifacts.length,
    mountedFixtureFiles: ["package.json", "index.html", "vite.config.js", "src/App.jsx", "src/main.jsx"],
    executionHost: "strict-csp-chrome-process-worker",
    headers: workerHeaders,
    attempts: attempts.map(({ command, result }) => ({
      command,
      exitCode: result.result?.exitCode ?? null,
      error: (result.error ?? result.result?.stderr ?? "").split("\n")[0]
    }))
  };
  process.stdout.write(`${JSON.stringify(observed, null, 2)}\n`);
  for (const attempt of observed.attempts) {
    assert.match(attempt.error || "", /ECLICSPUNSUPPORTED: .*\/workspace\/project\/node_modules\/picomatch\/index\.js/);
    assert.equal(attempt.exitCode, 1);
  }
} finally {
  await browser.close();
  await server.close();
}
