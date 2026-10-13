import { chromium } from "@playwright/test";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { MemoryPackageManagerWorkspace } from "../../../packages/node-runtime/src/package-managers/workspace.ts";

const root = new URL("../../..", import.meta.url).pathname;
const packageRoot = path.join(root, "dist/sdk/package");
const packageTarball = path.join(root, "dist/sdk/nuriteo-sdk-0.1.0-beta.1.tgz");
const publicRoot = path.join(packageRoot, "examples/sdk-consumer/public");
const chromePath = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

if (!fs.existsSync(chromePath)) {
  throw new Error(`Chrome not found at ${chromePath}`);
}
if (!fs.existsSync(path.join(packageRoot, "asset-manifest.json"))) {
  throw new Error("SDK package missing; run tooling/release/package-sdk.ts first");
}
if (!fs.existsSync(path.join(packageRoot, "index.d.ts"))) {
  throw new Error("SDK package missing root types; run tooling/release/package-sdk.ts first");
}
if (!fs.existsSync(path.join(packageRoot, "index.cjs"))) {
  throw new Error("SDK package missing CommonJS entry; run tooling/release/package-sdk.ts first");
}
if (!fs.existsSync(path.join(packageRoot, "README.md"))) {
  throw new Error("SDK package missing README; run tooling/release/package-sdk.ts first");
}
if (!fs.existsSync(packageTarball)) {
  throw new Error("SDK package tarball missing; run tooling/release/package-sdk.ts first");
}

const csp = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
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
      systemWasmPath: manifest.assets.systemWasm.path,
      yarnFactoryPath: manifest.assets.yarnClassicFactory.path,
      yarnFactorySha256: manifest.assets.yarnClassicFactory.sha256,
      yarnFactoryType: (await fetch("/sdk/vendor/yarn-cli-1.22.22.mjs")).headers.get("content-type"),
      nextFactoryPath: manifest.assets.nextCliFactory.path,
      nextFactorySha256: manifest.assets.nextCliFactory.sha256,
      nextFactoryType: (await fetch("/sdk/vendor/next-cli-15.5.26.mjs")).headers.get("content-type"),
      viteFactoryPath: manifest.assets.viteStaticFactories.path,
      viteFactoryType: (await fetch("/sdk/vendor/vite-8.2.0/vite-cli-static-factories.mjs")).headers.get("content-type"),
      rolldownWasiPath: manifest.assets.rolldownWasi.path,
      rolldownWasiType: (await fetch("/sdk/vendor/vite-8.2.0/assets/rolldown-binding.wasm")).headers.get("content-type")
    };
  });
  if (!headers.isolated) throw new Error("consumer page is not cross-origin isolated");
  if (!headers.workerType?.includes("text/javascript")) throw new Error(`worker MIME mismatch: ${headers.workerType}`);
  if (headers.wasmType !== "application/wasm") throw new Error(`wasm MIME mismatch: ${headers.wasmType}`);
  if (headers.manifestBasePath !== "/sdk/") throw new Error("SDK manifest base path mismatch");
  if (headers.systemWorkerPath !== "workers/system-worker.ts") throw new Error("SDK worker asset path mismatch");
  if (headers.systemWasmPath !== "assets/system_wasm.wasm") throw new Error("SDK wasm asset path mismatch");
  if (headers.yarnFactoryPath !== "vendor/yarn-cli-1.22.22.mjs") throw new Error("SDK Yarn factory asset path mismatch");
  if (!headers.yarnFactoryType?.includes("text/javascript")) throw new Error(`SDK Yarn factory MIME mismatch: ${headers.yarnFactoryType}`);
  if (headers.nextFactoryPath !== "vendor/next-cli-15.5.26.mjs") throw new Error("SDK Next factory asset path mismatch");
  if (!headers.nextFactoryType?.includes("text/javascript")) throw new Error(`SDK Next factory MIME mismatch: ${headers.nextFactoryType}`);
  if (headers.viteFactoryPath !== "vendor/vite-8.2.0/vite-cli-static-factories.mjs") throw new Error("SDK Vite factory asset path mismatch");
  if (!headers.viteFactoryType?.includes("text/javascript")) throw new Error(`SDK Vite factory MIME mismatch: ${headers.viteFactoryType}`);
  if (headers.rolldownWasiPath !== "vendor/vite-8.2.0/assets/rolldown-binding.wasm") throw new Error("SDK Rolldown WASI asset path mismatch");
  if (headers.rolldownWasiType !== "application/wasm") throw new Error(`SDK Rolldown WASI MIME mismatch: ${headers.rolldownWasiType}`);
  const yarnGate = JSON.parse(fs.readFileSync(path.join(root, "compat/yarn-v1-product-support.json"), "utf8"));
  if (headers.yarnFactorySha256 !== yarnGate.artifact.cspFactorySha256) throw new Error("SDK Yarn factory integrity manifest mismatch");
  const packagedYarnFactory = path.join(packageRoot, headers.yarnFactoryPath);
  if (fs.readFileSync(packagedYarnFactory).equals(fs.readFileSync(path.join(root, yarnGate.artifact.cspFactory))) === false) {
    throw new Error("SDK Yarn factory differs from preview product asset");
  }
  const nextEvidence = JSON.parse(fs.readFileSync(path.join(root, "compat/nextjs-browser-worker-results.json"), "utf8"));
  if (headers.nextFactorySha256 !== nextEvidence.nextCliFactorySha256) throw new Error("SDK Next factory integrity manifest mismatch");
  const packagedNextFactory = path.join(packageRoot, headers.nextFactoryPath);
  if (fs.readFileSync(packagedNextFactory).equals(fs.readFileSync(path.join(root, "packages/workspace-runtime/assets/vendor/next-cli-15.5.26.mjs"))) === false) {
    throw new Error("SDK Next factory differs from preview product asset");
  }
  const packedEntries = spawnSync("tar", ["-tzf", packageTarball], { encoding: "utf8" });
  if (packedEntries.status !== 0 || !packedEntries.stdout.includes("package/vendor/yarn-cli-1.22.22.mjs")) {
    throw new Error("SDK tarball is missing the Yarn Classic factory");
  }
  if (!packedEntries.stdout.includes("package/vendor/next-cli-15.5.26.mjs")) {
    throw new Error("SDK tarball is missing the Next.js factory");
  }
  for (const entry of [
    "package/vendor/vite-8.2.0/vite-cli-static-factories.mjs",
    "package/vendor/vite-8.2.0/rolldown-wasi-binding.mjs",
    "package/vendor/vite-8.2.0/assets/rolldown-binding.wasm"
  ]) {
    if (!packedEntries.stdout.includes(entry)) throw new Error(`SDK tarball is missing ${entry}`);
  }
  assertSourceMap("packages/sdk/src/container.ts");
  assertSourceMap("packages/browser-host/src/supervisor.ts");
  assertCommonjsEntry();

  const types = fs.readFileSync(path.join(packageRoot, "index.d.ts"), "utf8");
  if (!types.includes("Nuriteo")) throw new Error("SDK root types do not export Nuriteo");
  if (!types.includes("NuriteoServices")) throw new Error("SDK root types do not export service APIs");
  if (!types.includes("createNuriteoWebContainer")) throw new Error("SDK root types do not export WebContainer facade");
  if (!types.includes("createPreviewRelay")) throw new Error("SDK root types do not export preview API");
  const readme = fs.readFileSync(path.join(packageRoot, "README.md"), "utf8");
  if (!readme.includes("Cross-Origin-Opener-Policy")) throw new Error("SDK README missing hosting headers");
  if (!readme.includes("createContainer")) throw new Error("SDK README missing minimal usage");
  assertSdkTypesCompile();
  assertSdkTarballInstalls();

  const hasConsumer = await page.evaluate(() => Boolean(globalThis.__sdkConsumer?.bootAndRun));
  if (!hasConsumer) throw new Error(`SDK consumer did not initialize: ${browserErrors.join("\n") || "no browser error captured"}`);
  const result = await page.evaluate(() => globalThis.__sdkConsumer.bootAndRun());
  if (result.ready.role !== "system") throw new Error("SDK consumer did not boot system worker");
  if (result.run.exports?.value !== "hello") throw new Error("SDK consumer fs smoke failed");
  if (result.run.exports?.size !== 5) throw new Error("SDK consumer stat smoke failed");
  if (result.services !== "function") throw new Error("SDK consumer service API missing");
  if (result.status !== "stopped") throw new Error("SDK consumer did not teardown");
  const yarnPackageRoot = path.join(root, "vendor/cli/yarn/1.22.22/package");
  const yarnWorkspace = new MemoryPackageManagerWorkspace([
    ...["bin/yarn.js", "lib/cli.js", "lib/v8-compile-cache.js", "package.json"].map((name) => ({
      path: `/workspace/vendor/yarn/package/${name}`,
      data: fs.readFileSync(path.join(yarnPackageRoot, name), "utf8")
    })),
    { path: "/workspace/project/package.json", data: JSON.stringify({ name: "sdk-yarn-smoke", private: true }) }
  ]);
  const yarnVersion = await page.evaluate(async (snapshot) => {
    const worker = new Worker("/sdk/workers/process-worker.ts", { type: "module" });
    try {
      return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("SDK Yarn Worker timed out")), 30000);
        worker.addEventListener("message", (event) => {
          if (event.data?.type !== "cli:result") return;
          clearTimeout(timer);
          resolve(event.data);
        });
        worker.addEventListener("error", (event) => { clearTimeout(timer); reject(new Error(event.message)); });
        worker.postMessage({
          id: 7,
          type: "cli:evaluate",
          root: "/workspace",
          request: {
            args: ["--version"], cwd: "/workspace/project",
            entry: { entry: "/workspace/vendor/yarn/package/bin/yarn.js", name: "yarn", version: "1.22.22" }
          },
          workspaceSnapshot: snapshot
        });
      });
    } finally { worker.terminate(); }
  }, yarnWorkspace.snapshot());
  if (yarnVersion.error || yarnVersion.result?.exitCode !== 0 || yarnVersion.result.stdout !== "1.22.22\n") {
    throw new Error(`Packaged SDK Yarn Worker failed: ${yarnVersion.error || yarnVersion.result?.stderr}`);
  }
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}

console.log("sdk consumer package test ok");

function assertSdkTypesCompile() {
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "sdk-types-consumer-"));
  try {
    const scope = path.join(workdir, "node_modules/@nuriteo");
    fs.mkdirSync(scope, { recursive: true });
    fs.symlinkSync(packageRoot, path.join(scope, "sdk"), "dir");
    fs.writeFileSync(path.join(workdir, "index.ts"), [
      'import { Nuriteo, NuriteoServices, SdkError, createNuriteoMountSnapshot, createNuriteoWebContainer, createContainer, createPreviewRelay, createPreviewSessionRegistry, protocolVersion, resolveNuriteoWorkerAssets } from "@nuriteo/sdk";',
      "",
      "const container: Nuriteo = createContainer({",
      '  systemWorkerUrl: new URL("http://127.0.0.1/system-worker.ts"),',
      '  processWorkerUrl: new URL("http://127.0.0.1/process-worker.ts")',
      "});",
      "const sessions = createPreviewSessionRegistry();",
      "const services = new NuriteoServices();",
      'const assets = resolveNuriteoWorkerAssets("https://cdn.example/sdk/");',
      'const facade = createNuriteoWebContainer({ services, workdirName: "project" });',
      'const mount = createNuriteoMountSnapshot({ "README.md": "hello" });',
      'const error: SdkError | null = null;',
      "createPreviewRelay({ sessions });",
      "const version: number = protocolVersion;",
      "void container;",
      "void services;",
      "void assets;",
      "void facade;",
      "void mount;",
      "void error;",
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
      'import { Nuriteo, NuriteoServices, SdkError, createNuriteoMountSnapshot, createNuriteoWebContainer, createContainer, protocolVersion, resolveNuriteoWorkerAssets } from "@nuriteo/sdk";',
      "",
      "const container: Nuriteo = createContainer({",
      '  systemWorkerUrl: new URL("http://127.0.0.1/system-worker.ts"),',
      '  processWorkerUrl: new URL("http://127.0.0.1/process-worker.ts")',
      "});",
      "const version: number = protocolVersion;",
      "const services = new NuriteoServices();",
      'const assets = resolveNuriteoWorkerAssets("https://cdn.example/sdk/");',
      'const facade = createNuriteoWebContainer({ services, workdirName: "project" });',
      'const mount = createNuriteoMountSnapshot({ "README.md": "hello" });',
      'const error: SdkError | null = null;',
      "void container;",
      "void services;",
      "void assets;",
      "void version;",
      "void facade;",
      "void mount;",
      "void error;",
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
    fs.writeFileSync(path.join(workdir, "tsconfig.build.json"), `${JSON.stringify({
      compilerOptions: {
        lib: ["ES2024", "DOM"],
        module: "ESNext",
        moduleResolution: "Bundler",
        outDir: "dist",
        strict: true,
        target: "ES2024",
        types: []
      },
      include: ["index.ts"]
    }, null, 2)}\n`);
    const build = spawnSync(process.execPath, [
      path.join(root, "node_modules/typescript/bin/tsc"),
      "--project",
      "tsconfig.build.json",
      "--pretty",
      "false"
    ], {
      cwd: workdir,
      encoding: "utf8"
    });
    if (build.status !== 0) {
      throw new Error(`Installed SDK tarball consumer build failed:\n${build.stdout}\n${build.stderr}`);
    }
    if (!fs.existsSync(path.join(workdir, "dist/index.js"))) {
      throw new Error("Installed SDK tarball consumer build did not emit dist/index.js");
    }
    fs.writeFileSync(path.join(workdir, "consumer.cjs"), [
      'const sdk = require("@nuriteo/sdk");',
      'if (typeof sdk.createContainer !== "function") throw new Error("missing createContainer");',
      'if (typeof sdk.createPreviewRelay !== "function") throw new Error("missing createPreviewRelay");',
      'if (typeof sdk.NuriteoServices !== "function") throw new Error("missing NuriteoServices");',
      'if (typeof sdk.resolveNuriteoWorkerAssets !== "function") throw new Error("missing resolveNuriteoWorkerAssets");',
      'if (typeof sdk.createNuriteoWebContainer !== "function") throw new Error("missing createNuriteoWebContainer");',
      'if (typeof sdk.SdkError !== "function") throw new Error("missing SdkError");',
      'if (sdk.protocolVersion !== 1) throw new Error("protocol version mismatch");',
      ""
    ].join("\n"));
    const cjs = spawnSync(process.execPath, [path.join(workdir, "consumer.cjs")], {
      cwd: workdir,
      encoding: "utf8"
    });
    if (cjs.status !== 0) {
      throw new Error(`Installed SDK tarball CommonJS entry failed:\n${cjs.stdout}\n${cjs.stderr}`);
    }
  } finally {
    fs.rmSync(workdir, { recursive: true, force: true });
  }
}

function assertCommonjsEntry() {
  const cjs = spawnSync(process.execPath, ["-e", [
    `const sdk = require(${JSON.stringify(path.join(packageRoot, "index.cjs"))});`,
    'if (typeof sdk.createContainer !== "function") throw new Error("missing createContainer");',
    'if (typeof sdk.createPreviewRelay !== "function") throw new Error("missing createPreviewRelay");',
    'if (typeof sdk.NuriteoServices !== "function") throw new Error("missing NuriteoServices");',
    'if (typeof sdk.resolveNuriteoWorkerAssets !== "function") throw new Error("missing resolveNuriteoWorkerAssets");',
    'if (typeof sdk.createNuriteoWebContainer !== "function") throw new Error("missing createNuriteoWebContainer");',
    'if (typeof sdk.SdkError !== "function") throw new Error("missing SdkError");',
    'if (sdk.protocolVersion !== 1) throw new Error("protocol version mismatch");'
  ].join("")], {
    cwd: root,
    encoding: "utf8"
  });
  if (cjs.status !== 0) {
    throw new Error(`SDK CommonJS entry failed:\n${cjs.stdout}\n${cjs.stderr}`);
  }
}
