import { chromium } from "@playwright/test";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = new URL("../..", import.meta.url).pathname;
const packageRoot = path.join(root, "dist/sdk/package");
const packageTarball = path.join(root, "dist/sdk/cargo-container-sdk-0.0.0.tgz");
const publicRoot = path.join(packageRoot, "examples/sdk-consumer/public");
const chromePath = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

if (!fs.existsSync(chromePath)) {
  throw new Error(`Chrome not found at ${chromePath}`);
}
if (!fs.existsSync(path.join(packageRoot, "asset-manifest.json"))) {
  throw new Error("SDK package missing; run scripts/package-sdk.mjs first");
}
if (!fs.existsSync(path.join(packageRoot, "index.d.ts"))) {
  throw new Error("SDK package missing root types; run scripts/package-sdk.mjs first");
}
if (!fs.existsSync(packageTarball)) {
  throw new Error("SDK package tarball missing; run scripts/package-sdk.mjs first");
}

const csp = [
  "default-src 'self'",
  "script-src 'self'",
  "worker-src 'self'",
  "connect-src 'self'",
  "img-src 'self' data:",
  "style-src 'self'"
].join("; ");

const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".ts": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm"
};

function resolveFile(pathname) {
  if (pathname === "/" || pathname === "") return path.join(publicRoot, "index.html");
  if (pathname.startsWith("/sdk/")) return path.join(packageRoot, pathname.slice("/sdk/".length));
  return path.join(publicRoot, pathname.slice(1));
}

const server = http.createServer((request, response) => {
  const url = new URL(request.url || "/", "http://127.0.0.1");
  const file = resolveFile(url.pathname);
  if (!file.startsWith(packageRoot + path.sep)) {
    response.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Forbidden");
    return;
  }
  fs.readFile(file, (error, bytes) => {
    if (error) {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Not found");
      return;
    }
    response.writeHead(200, {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
      "Content-Security-Policy": csp,
      "Content-Type": mime[path.extname(file)] || "application/octet-stream"
    });
    response.end(bytes);
  });
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true, executablePath: chromePath });

try {
  const page = await browser.newPage();
  const browserErrors = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  await page.goto(baseUrl, { waitUntil: "load" });
  const headers = await page.evaluate(async () => {
    const worker = await fetch("/sdk/workers/system-worker.ts");
    const wasm = await fetch("/sdk/assets/system_wasm.wasm");
    const manifest = await fetch("/sdk/asset-manifest.json").then((response) => response.json());
    return {
      isolated: crossOriginIsolated,
      workerType: worker.headers.get("content-type"),
      wasmType: wasm.headers.get("content-type"),
      manifestBasePath: manifest.basePath,
      systemWorkerPath: manifest.assets.systemWorker.path,
      systemWasmPath: manifest.assets.systemWasm.path
    };
  });
  if (!headers.isolated) throw new Error("consumer page is not cross-origin isolated");
  if (!headers.workerType?.includes("text/javascript")) throw new Error(`worker MIME mismatch: ${headers.workerType}`);
  if (headers.wasmType !== "application/wasm") throw new Error(`wasm MIME mismatch: ${headers.wasmType}`);
  if (headers.manifestBasePath !== "/sdk/") throw new Error("SDK manifest base path mismatch");
  if (headers.systemWorkerPath !== "workers/system-worker.ts") throw new Error("SDK worker asset path mismatch");
  if (headers.systemWasmPath !== "assets/system_wasm.wasm") throw new Error("SDK wasm asset path mismatch");
  assertSourceMap("packages/sdk/src/container.ts");
  assertSourceMap("packages/browser-host/src/supervisor.ts");

  const types = fs.readFileSync(path.join(packageRoot, "index.d.ts"), "utf8");
  if (!types.includes("CargoContainer")) throw new Error("SDK root types do not export CargoContainer");
  if (!types.includes("createPreviewRelay")) throw new Error("SDK root types do not export preview API");
  assertSdkTypesCompile();
  assertSdkTarballInstalls();

  const hasConsumer = await page.evaluate(() => Boolean(globalThis.__sdkConsumer?.bootAndRun));
  if (!hasConsumer) throw new Error(`SDK consumer did not initialize: ${browserErrors.join("\n") || "no browser error captured"}`);
  const result = await page.evaluate(() => globalThis.__sdkConsumer.bootAndRun());
  if (result.ready.role !== "system") throw new Error("SDK consumer did not boot system worker");
  if (result.run.exports?.value !== "hello") throw new Error("SDK consumer fs smoke failed");
  if (result.run.exports?.size !== 5) throw new Error("SDK consumer stat smoke failed");
  if (result.status !== "stopped") throw new Error("SDK consumer did not teardown");
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}

console.log("sdk consumer package test ok");

function assertSdkTypesCompile() {
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "sdk-types-consumer-"));
  try {
    const scope = path.join(workdir, "node_modules/@cargo-container");
    fs.mkdirSync(scope, { recursive: true });
    fs.symlinkSync(packageRoot, path.join(scope, "sdk"), "dir");
    fs.writeFileSync(path.join(workdir, "index.ts"), [
      'import { CargoContainer, createContainer, createPreviewRelay, createPreviewSessionRegistry, protocolVersion } from "@cargo-container/sdk";',
      "",
      "const container: CargoContainer = createContainer({",
      '  systemWorkerUrl: new URL("http://127.0.0.1/system-worker.ts"),',
      '  processWorkerUrl: new URL("http://127.0.0.1/process-worker.ts")',
      "});",
      "const sessions = createPreviewSessionRegistry();",
      "createPreviewRelay({ sessions });",
      "const version: number = protocolVersion;",
      "void container;",
      "void version;",
      ""
    ].join("\n"));
    fs.writeFileSync(path.join(workdir, "tsconfig.json"), `${JSON.stringify({
      compilerOptions: {
        allowImportingTsExtensions: true,
        lib: ["ES2024", "DOM"],
        module: "ESNext",
        moduleResolution: "Bundler",
        noEmit: true,
        strict: true,
        target: "ES2024",
        types: []
      },
      include: ["index.ts"]
    }, null, 2)}\n`);
    const tsc = spawnSync(process.execPath, [path.join(root, "node_modules/typescript/bin/tsc"), "--pretty", "false"], {
      cwd: workdir,
      encoding: "utf8"
    });
    if (tsc.status !== 0) {
      throw new Error(`SDK package types do not compile:\n${tsc.stdout}\n${tsc.stderr}`);
    }
  } finally {
    fs.rmSync(workdir, { recursive: true, force: true });
  }
}

function assertSourceMap(packagePath) {
  const file = path.join(packageRoot, packagePath);
  const source = fs.readFileSync(file, "utf8");
  const sourceMapName = `${path.basename(packagePath, ".ts")}.js.map`;
  if (!source.includes(`sourceMappingURL=${sourceMapName}`)) {
    throw new Error(`Packaged source is missing sourceMappingURL: ${packagePath}`);
  }
  if (!fs.existsSync(path.join(path.dirname(file), sourceMapName))) {
    throw new Error(`Packaged source map is missing: ${packagePath}`);
  }
}

function assertSdkTarballInstalls() {
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "sdk-tarball-consumer-"));
  try {
    fs.writeFileSync(path.join(workdir, "package.json"), `${JSON.stringify({
      private: true,
      type: "module"
    }, null, 2)}\n`);
    const install = spawnSync("npm", [
      "install",
      packageTarball,
      "--cache",
      path.join(workdir, ".npm-cache"),
      "--ignore-scripts",
      "--no-audit",
      "--no-fund"
    ], {
      cwd: workdir,
      encoding: "utf8"
    });
    if (install.status !== 0) {
      throw new Error(`SDK tarball install failed:\n${install.stdout}\n${install.stderr}`);
    }
    fs.writeFileSync(path.join(workdir, "index.ts"), [
      'import { CargoContainer, createContainer, protocolVersion } from "@cargo-container/sdk";',
      "",
      "const container: CargoContainer = createContainer({",
      '  systemWorkerUrl: new URL("http://127.0.0.1/system-worker.ts"),',
      '  processWorkerUrl: new URL("http://127.0.0.1/process-worker.ts")',
      "});",
      "const version: number = protocolVersion;",
      "void container;",
      "void version;",
      ""
    ].join("\n"));
    fs.writeFileSync(path.join(workdir, "tsconfig.json"), `${JSON.stringify({
      compilerOptions: {
        allowImportingTsExtensions: true,
        lib: ["ES2024", "DOM"],
        module: "ESNext",
        moduleResolution: "Bundler",
        noEmit: true,
        strict: true,
        target: "ES2024",
        types: []
      },
      include: ["index.ts"]
    }, null, 2)}\n`);
    const tsc = spawnSync(process.execPath, [path.join(root, "node_modules/typescript/bin/tsc"), "--pretty", "false"], {
      cwd: workdir,
      encoding: "utf8"
    });
    if (tsc.status !== 0) {
      throw new Error(`Installed SDK tarball types do not compile:\n${tsc.stdout}\n${tsc.stderr}`);
    }
  } finally {
    fs.rmSync(workdir, { recursive: true, force: true });
  }
}
