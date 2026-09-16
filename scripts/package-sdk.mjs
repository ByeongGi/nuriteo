import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const root = process.cwd();
const outRoot = path.join(root, "dist/sdk");
const packageRoot = path.join(outRoot, "package");
const wasmSource = path.join(root, "target/wasm32-unknown-unknown/debug/system_wasm.wasm");
const packageTarballName = "cargo-container-sdk-0.0.0.tgz";

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
    const sourceFileName = path.relative(packageRoot, file);
    const sourceMapName = `${path.basename(file, ".ts")}.js.map`;
    const output = ts.transpileModule(source, {
      compilerOptions: {
        importsNotUsedAsValues: ts.ImportsNotUsedAsValues.Remove,
        module: ts.ModuleKind.ESNext,
        sourceMap: true,
        target: ts.ScriptTarget.ES2024,
        useDefineForClassFields: true
      },
      fileName: sourceFileName
    });
    fs.writeFileSync(file, output.outputText);
    if (output.sourceMapText) {
      fs.writeFileSync(path.join(path.dirname(file), sourceMapName), output.sourceMapText);
    } else if (!output.outputText.includes(`sourceMappingURL=${sourceMapName}`)) {
      throw new Error(`TypeScript transpile did not produce a source map for ${sourceFileName}`);
    }
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

function emitCommonjsRuntime() {
  const inputs = [
    "packages/browser-host/src/supervisor.ts",
    "packages/sdk/src/container.ts",
    "packages/preview/src/error-overlay.ts",
    "packages/preview/src/hmr-client.ts",
    "packages/preview/src/index.ts",
    "packages/preview/src/relay.ts",
    "packages/preview/src/service-worker.ts",
    "packages/preview/src/session.ts",
    "packages/preview/src/source-map.ts",
    "packages/preview/src/vite-diagnostics.ts",
    "packages/preview/src/vite-hmr-url.ts",
    "packages/protocol/src/messages.ts"
  ];
  for (const relativeFile of inputs) {
    const sourceFile = path.join(packageRoot, relativeFile);
    const outFile = path.join(packageRoot, "cjs", relativeFile.replace(/\.ts$/, ".cjs"));
    const source = fs.readFileSync(sourceFile, "utf8");
    const output = ts.transpileModule(source, {
      compilerOptions: {
        importsNotUsedAsValues: ts.ImportsNotUsedAsValues.Remove,
        module: ts.ModuleKind.CommonJS,
        sourceMap: true,
        target: ts.ScriptTarget.ES2022,
        useDefineForClassFields: true
      },
      fileName: relativeFile
    });
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, rewriteCommonjsSpecifiers(output.outputText));
    if (output.sourceMapText) {
      fs.writeFileSync(path.join(path.dirname(outFile), `${path.basename(outFile, ".cjs")}.js.map`), output.sourceMapText);
    }
  }
}

function browserTypescriptShim() {
  return [
    "const ModuleKind = Object.freeze({ CommonJS: 1, ESNext: 99 });",
    "const ScriptTarget = Object.freeze({ ES2024: 11 });",
    "const ImportsNotUsedAsValues = Object.freeze({ Remove: 0 });",
    "function transpileModule(source) {",
    "  return { outputText: String(source), diagnostics: [], sourceMapText: \"\" };",
    "}",
    "const ts = Object.freeze({ ImportsNotUsedAsValues, ModuleKind, ScriptTarget, transpileModule });",
    "export { ImportsNotUsedAsValues, ModuleKind, ScriptTarget, transpileModule };",
    "export default ts;",
    ""
  ].join("\n");
}

function rewriteCommonjsSpecifiers(source) {
  return source
    .replaceAll(".ts\")", ".cjs\")")
    .replaceAll(".ts')", ".cjs')");
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
rewritePackagedSource("packages/node-runtime/src/transforms/typescript.ts", [
  ['"typescript"', '"../../../../shims/typescript.js"']
]);
rewritePackagedSource("packages/node-runtime/src/builtins/zlib.ts", [
  ['"fflate"', '"../../../../node_modules/fflate/esm/browser.js"']
]);
writeFile("shims/typescript.js", browserTypescriptShim());
writeFile("node_modules/fflate/esm/browser.js", fs.readFileSync(path.join(root, "node_modules/fflate/esm/browser.js"), "utf8"));
emitDeclarations();
rewritePackagedDeclarations();
emitCommonjsRuntime();
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

writeFile("index.cjs", [
  "\"use strict\";",
  "Object.assign(exports, require('./cjs/packages/sdk/src/container.cjs'));",
  "Object.assign(exports, require('./cjs/packages/preview/src/index.cjs'));",
  "Object.assign(exports, require('./cjs/packages/protocol/src/messages.cjs'));",
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
      require: "./index.cjs",
      default: "./index.js"
    }
  }
}, null, 2)}\n`);

writeFile("README.md", `# Cargo Container SDK

Browser-native runtime SDK for booting the Cargo Container workers, running programs, and wiring preview primitives.

## Install

\`\`\`sh
npm install ./cargo-container-sdk-0.0.0.tgz
\`\`\`

## Browser Headers

Serve the consumer page and \`/sdk/**\` assets with:

\`\`\`text
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
Content-Security-Policy: default-src 'self'; script-src 'self'; worker-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'
\`\`\`

Serve \`assets/system_wasm.wasm\` as \`application/wasm\`.

## Usage

\`\`\`ts
import { createContainer } from "@cargo-container/sdk";

const container = createContainer({
  systemWorkerUrl: new URL("/sdk/workers/system-worker.ts", location.href),
  processWorkerUrl: new URL("/sdk/workers/process-worker.ts", location.href)
});

await container.boot();
await container.teardown();
\`\`\`

See \`docs/productization/sdk-quickstart.md\` in the repository for the full productization quickstart.
`);

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

const pack = spawnSync("npm", ["pack", packageRoot, "--pack-destination", outRoot], {
  cwd: root,
  encoding: "utf8",
  stdio: "pipe"
});
if (pack.status !== 0) {
  console.error(pack.stderr || pack.stdout);
  process.exit(pack.status ?? 1);
}
const packedName = pack.stdout.trim().split("\n").at(-1);
if (packedName && packedName !== packageTarballName) {
  fs.renameSync(path.join(outRoot, packedName), path.join(outRoot, packageTarballName));
}

console.log(`sdk package written: ${path.relative(root, packageRoot)}`);
console.log(`sdk package tarball written: ${path.relative(root, path.join(outRoot, packageTarballName))}`);
