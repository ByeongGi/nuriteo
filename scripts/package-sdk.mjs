import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

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

function rewritePackagedSource(target, replacements) {
  const file = path.join(packageRoot, target);
  let source = fs.readFileSync(file, "utf8");
  for (const [from, to] of replacements) source = source.replaceAll(from, to);
  fs.writeFileSync(file, source);
}

function transpilePackagedTypescript() {
  for (const file of listFiles(packageRoot).filter((file) => file.endsWith(".ts") && !file.endsWith(".d.ts"))) {
    const source = fs.readFileSync(file, "utf8");
    const output = ts.transpileModule(source, {
      compilerOptions: {
        importsNotUsedAsValues: ts.ImportsNotUsedAsValues.Remove,
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2024,
        useDefineForClassFields: true
      },
      fileName: file
    });
    fs.writeFileSync(file, output.outputText);
  }
}

function emitDeclarations() {
  const declarationRoot = path.join(packageRoot, "types");
  const program = ts.createProgram({
    rootNames: [
      path.join(root, "packages/browser-host/src/supervisor.ts"),
      path.join(root, "packages/sdk/src/index.ts"),
      path.join(root, "packages/preview/src/index.ts"),
      path.join(root, "packages/protocol/src/index.ts")
    ],
    options: {
      allowImportingTsExtensions: true,
      declaration: true,
      emitDeclarationOnly: true,
      exactOptionalPropertyTypes: true,
      lib: ["lib.es2024.d.ts", "lib.dom.d.ts"],
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      noEmitOnError: true,
      noUncheckedIndexedAccess: true,
      outDir: declarationRoot,
      rootDir: root,
      strict: true,
      target: ts.ScriptTarget.ES2024,
      types: ["node"]
    }
  });
  const emit = program.emit();
  const diagnostics = ts.getPreEmitDiagnostics(program).concat(emit.diagnostics);
  if (diagnostics.length > 0) {
    const host = {
      getCanonicalFileName: (file) => file,
      getCurrentDirectory: () => root,
      getNewLine: () => "\n"
    };
    console.error(ts.formatDiagnosticsWithColorAndContext(diagnostics, host));
    process.exit(1);
  }
}

function rewritePackagedDeclarations() {
  rewritePackagedSource("types/packages/sdk/src/container.d.ts", [
    ['"@cargo-container/browser-host/supervisor"', '"../../browser-host/src/supervisor"'],
    ['"@cargo-container/protocol"', '"../../protocol/src/index"']
  ]);
  rewritePackagedSource("types/packages/sdk/src/index.d.ts", [
    ['"@cargo-container/protocol"', '"../../protocol/src/index"']
  ]);
}

function listFiles(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(entryPath));
    else if (entry.isFile()) files.push(entryPath);
  }
  return files;
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

rewritePackagedSource("packages/sdk/src/container.ts", [
  ['"@cargo-container/browser-host/supervisor"', '"../../browser-host/src/supervisor.ts"'],
  ['"@cargo-container/protocol"', '"../../protocol/src/index.ts"']
]);
rewritePackagedSource("packages/sdk/src/index.ts", [
  ['"@cargo-container/protocol"', '"../../protocol/src/index.ts"']
]);
emitDeclarations();
rewritePackagedDeclarations();
transpilePackagedTypescript();

fs.mkdirSync(path.join(packageRoot, "assets"), { recursive: true });
fs.copyFileSync(wasmSource, path.join(packageRoot, "assets/system_wasm.wasm"));

writeFile("index.js", [
  "export { CargoContainer, createContainer } from './packages/sdk/src/container.ts';",
  "export { createPreviewRelay, createPreviewServiceWorker, createPreviewSessionRegistry, createHmrClient } from './packages/preview/src/index.ts';",
  "export { protocolVersion } from './packages/protocol/src/messages.ts';",
  ""
].join("\n"));

writeFile("index.d.ts", [
  "export { CargoContainer, createContainer } from './types/packages/sdk/src/container';",
  "export { createPreviewRelay, createPreviewServiceWorker, createPreviewSessionRegistry, createHmrClient } from './types/packages/preview/src/index';",
  "export { protocolVersion } from './types/packages/protocol/src/messages';",
  ""
].join("\n"));

writeFile("package.json", `${JSON.stringify({
  name: "@cargo-container/sdk",
  version: "0.0.0",
  private: true,
  type: "module",
  types: "./index.d.ts",
  exports: {
    ".": {
      types: "./index.d.ts",
      default: "./index.js"
    }
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
