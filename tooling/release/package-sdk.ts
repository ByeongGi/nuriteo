import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ts from "typescript";
import {
  collectSdkFingerprint,
  FINGERPRINT_PATH,
  readJson,
  resolveSdkBasePath,
  shouldWriteFingerprint,
  writeFingerprint
} from "../shared/release-fingerprint.ts";

const root = process.cwd();
const outRoot = path.join(root, "dist/sdk");
const packageRoot = path.join(outRoot, "package");
const wasmSource = path.join(root, "target/wasm32-unknown-unknown/debug/system_wasm.wasm");
const sdkManifest = JSON.parse(fs.readFileSync(path.join(root, "packages/sdk/package.json"), "utf8"));
const sdkVersion = sdkManifest.version;
const packageTarballName = `nuriteo-sdk-${sdkVersion}.tgz`;
const sdkBasePath = resolveSdkBasePath();
const writeFingerprintFlag = shouldWriteFingerprint();
const sdkBaseUrl = (suffix) => new URL(suffix, `https://example.invalid${sdkBasePath}`).pathname;

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
    ['"@nuriteo/browser-host/supervisor"', '"../../browser-host/src/supervisor"'],
    ['"@nuriteo/protocol"', '"../../protocol/src/index"']
  ]);
  rewritePackagedSource("types/packages/sdk/src/index.d.ts", [
    ['"@nuriteo/protocol"', '"../../protocol/src/index"']
  ]);
}

function emitCommonjsRuntime() {
  const inputs = [
    "packages/browser-host/src/resources/browser-resource-policy.ts",
    "packages/browser-host/src/resources/index.ts",
    "packages/browser-host/src/supervisor.ts",
    "packages/sdk/src/container.ts",
    "packages/sdk/src/services.ts",
    "packages/sdk/src/webcontainer.ts",
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
fs.copyFileSync(path.join(root, "LICENSE"), path.join(packageRoot, "LICENSE"));
fs.copyFileSync(path.join(root, "NOTICE"), path.join(packageRoot, "NOTICE"));

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
fs.mkdirSync(path.join(packageRoot, "vendor"), { recursive: true });
fs.copyFileSync(
  path.join(root, "packages/workspace-runtime/assets/vendor/yarn-cli-1.22.22.mjs"),
  path.join(packageRoot, "vendor/yarn-cli-1.22.22.mjs")
);
fs.copyFileSync(
  path.join(root, "packages/workspace-runtime/assets/vendor/next-cli-15.5.26.mjs"),
  path.join(packageRoot, "vendor/next-cli-15.5.26.mjs")
);
fs.cpSync(
  path.join(root, "packages/workspace-runtime/assets/vendor/vite-8.2.0"),
  path.join(packageRoot, "vendor/vite-8.2.0"),
  { recursive: true }
);
const yarnGate = readJson(path.join(root, "compat/yarn-v1-product-support.json"));
if (sha256(path.join(packageRoot, "vendor/yarn-cli-1.22.22.mjs")) !== yarnGate.artifact.cspFactorySha256) {
  throw new Error("SDK Yarn Classic factory differs from the pinned product support asset");
}
const nextBrowserWorker = readJson(path.join(root, "compat/nextjs-browser-worker-results.json"));
if (sha256(path.join(packageRoot, "vendor/next-cli-15.5.26.mjs")) !== nextBrowserWorker.nextCliFactorySha256) {
  throw new Error("SDK Next.js factory differs from the pinned browser-worker evidence");
}

rewritePackagedSource("packages/sdk/src/container.ts", [
  ['"@nuriteo/browser-host/supervisor"', '"../../browser-host/src/supervisor.ts"'],
  ['"@nuriteo/protocol"', '"../../protocol/src/index.ts"']
]);
rewritePackagedSource("packages/sdk/src/index.ts", [
  ['"@nuriteo/protocol"', '"../../protocol/src/index.ts"']
]);
rewritePackagedSource("packages/node-runtime/src/transforms/typescript.ts", [
  ['"typescript"', '"../../../../shims/typescript.js"']
]);
rewritePackagedSource("packages/node-runtime/src/builtins/zlib.ts", [
  ['"fflate"', '"../../../../node_modules/fflate/esm/browser.js"']
]);
rewritePackagedSource("workers/process-worker.ts", [
  ['new URL("/runtime/system_wasm.wasm", self.location.origin)', 'new URL("../assets/system_wasm.wasm", self.location.href)']
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
  "export { Nuriteo, createContainer } from './packages/sdk/src/container.ts';",
  "export { NuriteoServices, NuriteoFileSystemApi, NuriteoPackageManagerApi, NuriteoPreviewApi, NuriteoProcessApi, NuriteoProjectApi, registerNuriteoPreviewServiceWorker, resolveNuriteoWorkerAssets, SdkError } from './packages/sdk/src/services.ts';",
  "export { NuriteoWebContainer, NuriteoWebContainerFileSystem, createNuriteoMountSnapshot, createNuriteoWebContainer } from './packages/sdk/src/webcontainer.ts';",
  "export { createPreviewRelay, createPreviewServiceWorker, createPreviewSessionRegistry, createHmrClient } from './packages/preview/src/index.ts';",
  "export { protocolVersion } from './packages/protocol/src/messages.ts';",
  ""
].join("\n"));

writeFile("index.d.ts", [
  "export { Nuriteo, createContainer } from './types/packages/sdk/src/container';",
  "export { NuriteoServices, NuriteoFileSystemApi, NuriteoPackageManagerApi, NuriteoPreviewApi, NuriteoProcessApi, NuriteoProjectApi, registerNuriteoPreviewServiceWorker, resolveNuriteoWorkerAssets, SdkError } from './types/packages/sdk/src/services';",
  "export type { NuriteoCommandResult, NuriteoServicesOptions, NuriteoFileEntry, NuriteoFileSystemAdapter, NuriteoFileWatchEvent, NuriteoPackageCommandOptions, NuriteoPackageManagerAdapter, NuriteoPreviewAdapter, NuriteoPreviewEvent, NuriteoPreviewPort, NuriteoProcessAdapter, NuriteoProcessHandle, NuriteoProcessSpawnOptions, NuriteoProjectAdapter, NuriteoSdkTraceEvent, NuriteoWorkerAssets, RegisterNuriteoPreviewServiceWorkerOptions, SdkErrorCode } from './types/packages/sdk/src/services';",
  "export { NuriteoWebContainer, NuriteoWebContainerFileSystem, createNuriteoMountSnapshot, createNuriteoWebContainer } from './types/packages/sdk/src/webcontainer';",
  "export type { NuriteoCoepMode, NuriteoFileSystemTree, NuriteoFileSystemTreeNode, NuriteoMountSnapshot, NuriteoSpawnOptions, NuriteoWebContainerEventName, NuriteoWebContainerLifecycle, NuriteoWebContainerOptions } from './types/packages/sdk/src/webcontainer';",
  "export { createPreviewRelay, createPreviewServiceWorker, createPreviewSessionRegistry, createHmrClient } from './types/packages/preview/src/index';",
  "export { protocolVersion } from './types/packages/protocol/src/messages';",
  ""
].join("\n"));

writeFile("index.cjs", [
  "\"use strict\";",
  "Object.assign(exports, require('./cjs/packages/sdk/src/container.cjs'));",
  "Object.assign(exports, require('./cjs/packages/sdk/src/services.cjs'));",
  "Object.assign(exports, require('./cjs/packages/sdk/src/webcontainer.cjs'));",
  "Object.assign(exports, require('./cjs/packages/preview/src/index.cjs'));",
  "Object.assign(exports, require('./cjs/packages/protocol/src/messages.cjs'));",
  ""
].join("\n"));

writeFile("package.json", `${JSON.stringify({
  name: "@nuriteo/sdk",
  version: sdkVersion,
  license: sdkManifest.license,
  publishConfig: sdkManifest.publishConfig,
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

writeFile("README.md", `# NURITEO SDK

Browser-native runtime SDK for booting NURITEO workers, running programs, and wiring preview primitives.

Licensed under the Apache License, Version 2.0. See \`LICENSE\` and \`NOTICE\` in the package.

## Install

\`\`\`sh
npm install ./nuriteo-sdk-${sdkVersion}.tgz
\`\`\`

## Browser Headers

Serve the consumer page and \`${sdkBasePath}**\` assets with:

\`\`\`text
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
Content-Security-Policy: default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'
\`\`\`

Serve \`assets/system_wasm.wasm\` as \`application/wasm\`.
Serve \`vendor/yarn-cli-1.22.22.mjs\` and \`vendor/next-cli-15.5.26.mjs\` as \`text/javascript\` beside the workers; the process worker verifies their SHA-256 values before loading the pinned CLI factories.
Serve \`vendor/vite-8.2.0/**\` beside the workers; the process worker verifies the static graph, Rolldown browser binding, nested Worker, and WASM hashes before loading them.

Asset base path for this package: \`${sdkBasePath}\`
Override at package time with \`--base-path=/your/deploy/path/\` or \`NURITEO_SDK_BASE_PATH\`.

## Usage

\`\`\`ts
import { createContainer } from "@nuriteo/sdk";

const container = createContainer({
  systemWorkerUrl: new URL(${JSON.stringify(sdkBaseUrl("workers/system-worker.ts"))}, location.href),
  processWorkerUrl: new URL(${JSON.stringify(sdkBaseUrl("workers/process-worker.ts"))}, location.href)
});

await container.boot();
await container.teardown();
\`\`\`

See \`docs/productization/sdk-quickstart.md\` in the repository for the full productization quickstart.
`);

writeFile("asset-manifest.json", `${JSON.stringify({
  schemaVersion: 1,
  basePath: sdkBasePath,
  requiredHeaders: {
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Embedder-Policy": "require-corp",
    "Content-Security-Policy": "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'"
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
    yarnClassicFactory: {
      path: "vendor/yarn-cli-1.22.22.mjs",
      sha256: sha256(path.join(packageRoot, "vendor/yarn-cli-1.22.22.mjs"))
    },
    nextCliFactory: {
      path: "vendor/next-cli-15.5.26.mjs",
      sha256: sha256(path.join(packageRoot, "vendor/next-cli-15.5.26.mjs"))
    },
    viteStaticFactories: {
      path: "vendor/vite-8.2.0/vite-cli-static-factories.mjs",
      sha256: sha256(path.join(packageRoot, "vendor/vite-8.2.0/vite-cli-static-factories.mjs"))
    },
    rolldownWasiBinding: {
      path: "vendor/vite-8.2.0/rolldown-wasi-binding.mjs",
      sha256: sha256(path.join(packageRoot, "vendor/vite-8.2.0/rolldown-wasi-binding.mjs"))
    },
    rolldownWasi: {
      path: "vendor/vite-8.2.0/assets/rolldown-binding.wasm",
      sha256: sha256(path.join(packageRoot, "vendor/vite-8.2.0/assets/rolldown-binding.wasm"))
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
    <title>NURITEO SDK Consumer</title>
  </head>
  <body>
    <pre id="status">loading</pre>
    <script type="module" src="./app.js"></script>
  </body>
</html>
`);

writeFile("examples/sdk-consumer/public/app.js", `import { NuriteoServices, createContainer, resolveNuriteoWorkerAssets } from ${JSON.stringify(sdkBaseUrl("index.js"))};

const status = document.getElementById("status");

function write(value) {
  status.textContent = typeof value === "string" ? value : JSON.stringify(value);
}

globalThis.__sdkConsumer = {
  async bootAndRun() {
    if (!crossOriginIsolated) throw new Error("cross-origin isolation missing");
    const assets = resolveNuriteoWorkerAssets(${JSON.stringify(sdkBasePath)});
    const services = new NuriteoServices();
    const container = createContainer({
      systemWorkerUrl: assets.systemWorkerUrl,
      processWorkerUrl: assets.processWorkerUrl,
      timeoutMs: 2500
    });
    const ready = await container.boot();
    const run = await container.run("", { entrypoint: "fs-smoke", timeoutMs: 7000 });
    const metrics = await container.systemMetrics();
    await container.teardown();
    const result = { ready, run, metrics, services: typeof services.fs.readFile, status: container.status };
    write(result);
    return result;
  }
};

write("ready");
`);

const packCache = fs.mkdtempSync(path.join(os.tmpdir(), "nuriteo-sdk-pack-"));
try {
  const pack = spawnSync("npm", [
    "pack",
    packageRoot,
    "--pack-destination",
    outRoot,
    "--cache",
    packCache
  ], {
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
} finally {
  fs.rmSync(packCache, { recursive: true, force: true });
}

const existingFingerprint = fs.existsSync(path.join(root, FINGERPRINT_PATH))
  ? readJson(path.join(root, FINGERPRINT_PATH))
  : null;
const fingerprint = collectSdkFingerprint({
  root,
  basePath: sdkBasePath,
  existing: existingFingerprint
});

if (writeFingerprintFlag) {
  const target = writeFingerprint(fingerprint, { root });
  console.log(`release fingerprint written: ${path.relative(root, target)}`);
} else {
  console.log("release fingerprint not updated; pass --write-fingerprint to refresh docs/release/fingerprint.json");
}

console.log(`sdk package written: ${path.relative(root, packageRoot)}`);
console.log(`sdk package tarball written: ${path.relative(root, path.join(outRoot, packageTarballName))}`);
console.log(`sdk asset base path: ${sdkBasePath}`);
console.log(`sdk fingerprint preview: assetManifest=${fingerprint.sdkPackage.assetManifestSha256.slice(0, 12)}… tarball=${fingerprint.sdkPackage.tarballSha256.slice(0, 12)}…`);
