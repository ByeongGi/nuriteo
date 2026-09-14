import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const outRoot = path.join(root, "dist/sdk");
const packageRoot = path.join(outRoot, "package");
const wasmSource = path.join(root, "target/wasm32-unknown-unknown/debug/system_wasm.wasm");

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function copyDir(source, target) {
  fs.cpSync(path.join(root, source), path.join(packageRoot, source), { recursive: true });
}

function writeFile(target, contents) {
  const file = path.join(packageRoot, target);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
}

const build = spawnSync("cargo", ["build", "-p", "system-wasm", "--target", "wasm32-unknown-unknown"], {
  cwd: root,
  encoding: "utf8",
  stdio: "pipe"
});
if (build.status !== 0) {
  console.error(build.stderr || build.stdout);
  process.exit(build.status ?? 1);
}

fs.rmSync(outRoot, { recursive: true, force: true });
fs.mkdirSync(packageRoot, { recursive: true });

for (const dir of [
  "packages/sdk",
  "packages/browser-host",
  "packages/node-runtime",
  "packages/preview",
  "packages/protocol",
  "workers",
  "vendor/manifests"
]) {
  copyDir(dir, path.join(packageRoot, dir));
}

fs.mkdirSync(path.join(packageRoot, "assets"), { recursive: true });
fs.copyFileSync(wasmSource, path.join(packageRoot, "assets/system_wasm.wasm"));

writeFile("index.js", [
  "export { CargoContainer, createContainer } from './packages/sdk/src/container.ts';",
  "export { createPreviewRelay, createPreviewServiceWorker, createPreviewSessionRegistry, createHmrClient } from './packages/preview/src/index.ts';",
  "export { protocolVersion } from './packages/protocol/src/messages.ts';",
  ""
].join("\n"));

writeFile("package.json", `${JSON.stringify({
  name: "@cargo-container/sdk",
  version: "0.0.0",
  private: true,
  type: "module",
  exports: {
    ".": "./index.js"
  }
}, null, 2)}\n`);

writeFile("asset-manifest.json", `${JSON.stringify({
  schemaVersion: 1,
  basePath: "/sdk/",
  requiredHeaders: {
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Embedder-Policy": "require-corp",
    "Content-Security-Policy": "default-src 'self'; script-src 'self'; worker-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'"
  },
  mimeTypes: {
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".ts": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".wasm": "application/wasm"
  },
  assets: {
    systemWorker: {
      path: "workers/system-worker.ts",
      sha256: sha256(path.join(packageRoot, "workers/system-worker.ts"))
    },
    processWorker: {
      path: "workers/process-worker.ts",
      sha256: sha256(path.join(packageRoot, "workers/process-worker.ts"))
    },
    systemWasm: {
      path: "assets/system_wasm.wasm",
      sha256: sha256(path.join(packageRoot, "assets/system_wasm.wasm"))
    }
  }
}, null, 2)}\n`);

writeFile("examples/sdk-consumer/public/index.html", `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>Cargo Container SDK Consumer</title>
  </head>
  <body>
    <pre id="status">loading</pre>
    <script type="module" src="./app.js"></script>
  </body>
</html>
`);

writeFile("examples/sdk-consumer/public/app.js", `import { createContainer } from "/sdk/index.js";

const status = document.getElementById("status");

function write(value) {
  status.textContent = typeof value === "string" ? value : JSON.stringify(value);
}

globalThis.__sdkConsumer = {
  async bootAndRun() {
    if (!crossOriginIsolated) throw new Error("cross-origin isolation missing");
    const container = createContainer({
      systemWorkerUrl: new URL("/sdk/workers/system-worker.ts", location.href),
      processWorkerUrl: new URL("/sdk/workers/process-worker.ts", location.href),
      timeoutMs: 2500
    });
    const ready = await container.boot();
    const run = await container.run("", { entrypoint: "fs-smoke", timeoutMs: 7000 });
    const metrics = await container.systemMetrics();
    await container.teardown();
    const result = { ready, run, metrics, status: container.status };
    write(result);
    return result;
  }
};

write("ready");
`);

console.log(`sdk package written: ${path.relative(root, packageRoot)}`);
