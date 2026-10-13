import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";

import { chromium } from "@playwright/test";
import { createServer } from "vite";
import { REQUIRED_RUNTIME_HEADERS } from "../../../packages/browser-host/src/security/headers.ts";
import { MemoryPackageManagerWorkspace } from "../../../packages/node-runtime/src/package-managers/workspace.ts";

const repositoryRoot = path.resolve(new URL("../../..", import.meta.url).pathname);
const artifactRoot = path.join(repositoryRoot, "vendor/cli/yarn/1.22.22/package");
const guestRoot = "/workspace/vendor/yarn/package";
const chromePath = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const tarball = gzipSync(createTar([
  { path: "package/package.json", body: bytes(JSON.stringify({ name: "fixture-registry", version: "1.0.0", main: "index.js" })) },
  { path: "package/index.js", body: bytes("module.exports = 'browser-registry-ok';\n") }
]));
let registryRequests = 0;
let holdNextTarball = false;
let pendingTarballResponse;
let tarballRequested;
let tamperFactoryResponse = false;
const workspace = new MemoryPackageManagerWorkspace([
  ...["bin/yarn.js", "lib/cli.js", "lib/v8-compile-cache.js", "package.json"].map((name) => ({
    path: `${guestRoot}/${name}`,
    data: fs.readFileSync(path.join(artifactRoot, name), "utf8")
  })),
  { path: "/workspace/project/package.json", data: JSON.stringify({ name: "yarn-browser-worker", private: true, dependencies: { "fixture-registry": "1.0.0" } }) }
]);

const server = await createServer({
  root: repositoryRoot,
  publicDir: path.join(repositoryRoot, "packages/workspace-runtime/assets"),
  configFile: false,
  server: { host: "127.0.0.1", port: 0 },
  plugins: [{
    name: "worker-isolation-headers",
    configureServer(vite) {
      vite.middlewares.use((request, response, next) => {
        response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
        response.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
        response.setHeader("Content-Security-Policy", REQUIRED_RUNTIME_HEADERS.csp);
        if (request.url === "/yarn-worker-fixture") {
          response.setHeader("Content-Type", "text/html");
          response.end("<!doctype html><html><body>Yarn browser worker fixture</body></html>");
          return;
        }
        if (request.url === "/vendor/yarn-cli-1.22.22.mjs" && tamperFactoryResponse) {
          response.setHeader("Content-Type", "text/javascript");
          response.end("export const sourceSha256 = 'tampered';\n");
          return;
        }
        if (request.url === "/fixture-registry") {
          registryRequests += 1;
          response.setHeader("Content-Type", "application/json");
          response.setHeader("Cache-Control", "no-store");
          response.end(JSON.stringify({
            name: "fixture-registry",
            versions: {
              "1.0.0": {
                name: "fixture-registry",
                version: "1.0.0",
                dist: {
                  integrity: `sha512-${crypto.createHash("sha512").update(tarball).digest("base64")}`,
                  shasum: crypto.createHash("sha1").update(tarball).digest("hex"),
                  tarball: `http://${request.headers.host}/fixture-registry-1.0.0.tgz`
                }
              }
            },
            "dist-tags": { latest: "1.0.0" }
          }));
          return;
        }
        if (request.url === "/fixture-registry-1.0.0.tgz") {
          registryRequests += 1;
          response.setHeader("Content-Type", "application/octet-stream");
          response.setHeader("Cache-Control", "no-store");
          if (holdNextTarball) {
            pendingTarballResponse = response;
            tarballRequested?.();
            return;
          }
          response.end(tarball);
          return;
        }
        next();
      });
    }
  }]
});
await server.listen();
const baseUrl = server.resolvedUrls.local[0];
const browser = await chromium.launch({ headless: true, executablePath: chromePath });
try {
  const page = await browser.newPage();
  await page.goto(`${baseUrl}yarn-worker-fixture`, { waitUntil: "load" });
  const runInBrowserWorker = (args) => page.evaluate(async ({ snapshot, args }) => {
    const worker = new Worker("/workers/process-worker.ts", { type: "module" });
    try {
      return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Yarn browser worker timed out")), 45000);
        worker.addEventListener("message", (event) => {
          if (event.data?.type !== "cli:result") return;
          clearTimeout(timer);
          resolve(event.data);
        });
        worker.addEventListener("error", (event) => {
          clearTimeout(timer);
          reject(new Error(`${event.message}\n${event.error?.stack || ""}\n${event.filename}:${event.lineno}:${event.colno}`));
        });
        worker.postMessage({
          id: 1,
          type: "cli:evaluate",
          root: "/workspace",
          settleTicks: 15000,
          settleTimeoutMs: 15000,
          request: {
            args,
            cwd: "/workspace/project",
            entry: { entry: "/workspace/vendor/yarn/package/bin/yarn.js", name: "yarn", version: "1.22.22" }
          },
          workspaceSnapshot: snapshot
        });
      });
    } finally {
      worker.terminate();
    }
  }, { snapshot: workspace.snapshot(), args });
  const version = await runInBrowserWorker(["--version"]);
  assert.equal(version.error, undefined, version.error);
  assert.equal(version.result.exitCode, 0, version.result.stderr);
  assert.equal(version.result.stdout, "1.22.22\n");
  const tamperedWorkspace = MemoryPackageManagerWorkspace.fromSnapshot(workspace.snapshot());
  tamperedWorkspace.writeText(`${guestRoot}/lib/cli.js`, `${tamperedWorkspace.readText(`${guestRoot}/lib/cli.js`)}\n// tampered`);
  const tampered = tamperedWorkspace.snapshot();
  const tamperedResult = await page.evaluate(async (snapshot) => {
    const worker = new Worker("/workers/process-worker.ts", { type: "module" });
    try {
      return await new Promise((resolve) => {
        worker.addEventListener("message", (event) => { if (event.data?.type === "cli:result") resolve(event.data); });
        worker.postMessage({ id: 9, type: "cli:evaluate", root: "/workspace", request: {
          args: ["--version"], cwd: "/workspace/project",
          entry: { entry: "/workspace/vendor/yarn/package/bin/yarn.js", name: "yarn", version: "1.22.22" }
        }, workspaceSnapshot: snapshot });
      });
    } finally { worker.terminate(); }
  }, tampered);
  assert.match(tamperedResult.error, /ERR_YARN_CSP_BUNDLE_INTEGRITY/);
  tamperFactoryResponse = true;
  const tamperedFactoryResult = await runInBrowserWorker(["--version"]);
  tamperFactoryResponse = false;
  assert.match(tamperedFactoryResult.error, /ERR_YARN_CSP_FACTORY_INTEGRITY/);

  const installed = await runInBrowserWorker([
    "install", "--ignore-scripts", "--non-interactive", "--registry", baseUrl, "--cache-folder", "/workspace/.yarn-cache"
  ]);
  assert.equal(installed.error, undefined, installed.error);
  assert.equal(installed.result.exitCode, 0, installed.result.stderr);
  assert.equal(registryRequests >= 2, true);
  const installedWorkspace = MemoryPackageManagerWorkspace.fromSnapshot(installed.result.workspaceSnapshot);
  assert.equal(installedWorkspace.readText("/workspace/project/node_modules/fixture-registry/index.js"), "module.exports = 'browser-registry-ok';\n");
  assert.match(installedWorkspace.readText("/workspace/project/yarn.lock"), /fixture-registry@1\.0\.0/);

  holdNextTarball = true;
  const waitingForTarball = new Promise((resolve) => { tarballRequested = resolve; });
  await page.evaluate((snapshot) => {
    const worker = new Worker("/workers/process-worker.ts", { type: "module" });
    globalThis.__yarnCancellationWorker = worker;
    worker.postMessage({
      id: 2,
      type: "cli:evaluate",
      root: "/workspace",
      request: {
        args: ["install", "--ignore-scripts", "--non-interactive", "--registry", location.origin, "--cache-folder", "/workspace/.yarn-cache"],
        cwd: "/workspace/project",
        entry: { entry: "/workspace/vendor/yarn/package/bin/yarn.js", name: "yarn", version: "1.22.22" }
      },
      workspaceSnapshot: snapshot
    });
  }, workspace.snapshot());
  let tarballTimeout;
  try {
    await Promise.race([
      waitingForTarball,
      new Promise((_resolve, reject) => {
        tarballTimeout = setTimeout(() => reject(new Error("cancel fixture never reached tarball fetch")), 30000);
      })
    ]);
  } finally {
    clearTimeout(tarballTimeout);
  }
  await page.evaluate(() => {
    globalThis.__yarnCancellationWorker.terminate();
    delete globalThis.__yarnCancellationWorker;
  });
  pendingTarballResponse?.destroy();
  holdNextTarball = false;
  const recovered = await runInBrowserWorker([
    "install", "--ignore-scripts", "--non-interactive", "--registry", baseUrl, "--cache-folder", "/workspace/.yarn-cache"
  ]);
  assert.equal(recovered.error, undefined, recovered.error);
  assert.equal(recovered.result.exitCode, 0, recovered.result.stderr);
  assert.equal(MemoryPackageManagerWorkspace.fromSnapshot(recovered.result.workspaceSnapshot).readText("/workspace/project/node_modules/fixture-registry/index.js"), "module.exports = 'browser-registry-ok';\n");
} finally {
  await browser.close();
  await server.close();
}

console.log("yarn browser worker real CLI test ok");

function bytes(value) {
  return new TextEncoder().encode(value);
}

function createTar(entries) {
  const chunks = [];
  for (const entry of entries) {
    const header = new Uint8Array(512);
    writeString(header, 0, 100, entry.path);
    writeString(header, 100, 8, "0000644");
    writeString(header, 108, 8, "0000000");
    writeString(header, 116, 8, "0000000");
    writeString(header, 124, 12, entry.body.byteLength.toString(8).padStart(11, "0"));
    writeString(header, 136, 12, "00000000000");
    header.fill(0x20, 148, 156);
    header[156] = "0".charCodeAt(0);
    writeString(header, 257, 6, "ustar");
    writeString(header, 263, 2, "00");
    writeString(header, 148, 6, header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, "0"));
    header[154] = 0;
    header[155] = 0x20;
    chunks.push(header, entry.body, new Uint8Array((512 - (entry.body.byteLength % 512)) % 512));
  }
  chunks.push(new Uint8Array(1024));
  const output = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function writeString(buffer, offset, length, value) {
  buffer.set(new TextEncoder().encode(value).subarray(0, length), offset);
}
