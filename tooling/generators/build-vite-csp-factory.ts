#!/usr/bin/env node
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { build } from "vite";
import { prepareCjsSourceForStaticFactory } from "../../packages/node-runtime/src/modules/cjs.ts";
import { prepareEsmStaticFactoryBody } from "../../packages/node-runtime/src/modules/esm.ts";
import { createWorkspaceModuleRuntime } from "../../packages/node-runtime/src/modules/index.ts";
import {
  createViteDependencyArtifactClosureFromWorkspace,
  createVitePackageArtifactFromWorkspace,
  ViteProductWorkflow
} from "../../packages/node-runtime/src/frameworks/vite-workflow.ts";
import { createFallbackWorkspaceReader, createNodeFsWorkspaceReader } from "../shared/fs-workspace-reader.ts";

const repositoryRoot = path.resolve(new URL("../..", import.meta.url).pathname);
const preparedRoot = process.env.NURITEO_FIXTURE_PREP_ROOT
  ? path.resolve(process.env.NURITEO_FIXTURE_PREP_ROOT)
  : "";
if (!preparedRoot) throw new Error("NURITEO_FIXTURE_PREP_ROOT is required");

const fixtureRevision = "1544bb1b7ac92f775e9d0dea97954c99cc6cbd43";
const viteVersion = "8.2.0";
const rolldownVersion = "1.2.8";
const fixtureCheckout = path.join(preparedRoot, "fixtures/vite-official-template-react");
const nodeModulesRoot = path.join(preparedRoot, "toolchain/node_modules");
const viteRoot = path.join(nodeModulesRoot, "vite");
assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { cwd: fixtureCheckout, encoding: "utf8" }).trim(), fixtureRevision);
assert.equal(JSON.parse(fs.readFileSync(path.join(viteRoot, "package.json"), "utf8")).version, viteVersion);

const projectRoot = "/workspace/project";
const vitePackageArtifact = createVitePackageArtifactFromWorkspace({
  packageRoot: "/vendor/vite",
  reader: createNodeFsWorkspaceReader({ root: viteRoot, virtualRoot: "/vendor/vite" })
});
const readers = [createNodeFsWorkspaceReader({ root: nodeModulesRoot, virtualRoot: `${projectRoot}/node_modules` })];
const pnpmHoistedRoot = path.join(nodeModulesRoot, ".pnpm/node_modules");
if (fs.existsSync(pnpmHoistedRoot)) {
  readers.push(createNodeFsWorkspaceReader({ root: pnpmHoistedRoot, virtualRoot: `${projectRoot}/node_modules` }));
}
const dependencyArtifacts = createViteDependencyArtifactClosureFromWorkspace({
  manager: "pnpm",
  nodeModulesRoot: `${projectRoot}/node_modules`,
  reader: createFallbackWorkspaceReader(readers),
  vitePackageArtifact
}).artifacts;
const workflow = new ViteProductWorkflow({
  dependencyArtifacts,
  manager: "pnpm",
  projectId: "vite-official-template-react",
  projectRoot,
  vitePackageArtifact
});
workflow.install();

const workspace = workflow.workspace;
const runtime = createWorkspaceModuleRuntime({ reader: workspace, root: "/workspace" });
const sourceHashes: Record<string, string> = {};
const cjsFactories: string[] = [];
const esmFactories: string[] = [];
const excluded: string[] = [];
const bindingModuleSuffix = "/node_modules/rolldown/dist/shared/binding-DH95uVkp.mjs";

for (const filename of [...workspace.files.keys()].sort()) {
  if (!filename.startsWith(`${projectRoot}/node_modules/`)) continue;
  if (!/\.(?:cjs|mjs|js)$/.test(filename)) continue;
  const definition = runtime.getDefinition(filename);
  if (!definition || (definition.kind !== "cjs-source" && definition.kind !== "esm-source")) continue;
  const source = workspace.readText(filename);
  sourceHashes[filename] = sha256(source);
  if (filename.endsWith(bindingModuleSuffix)) {
    esmFactories.push(`${JSON.stringify(filename)}: async (__context) => {
  const __binding = rolldownWasiBinding.default || rolldownWasiBinding;
  const __toESM = (value) => Object.assign({ default: value }, value);
  __context.exportConst("n", __toESM);
  __context.exportConst("t", () => __binding);
}`);
    continue;
  }
  if (filename === `${projectRoot}/node_modules/esbuild/index.js`) {
    esmFactories.push(`${JSON.stringify(filename)}: async (__context) => {
  const transformJsxModule = (source) => {
    const imports = source.split("\\n").filter((line) => {
      const text = line.trim();
      return text.startsWith("import ") && !/\\.(?:css|png|jpe?g|gif|svg|webp)(?:['\"]|$)/.test(text);
    }).join("\\n");
    if (/export\\s+default|function\\s+App\\b/.test(source)) return \`${"${imports}"}\\nfunction App() { return null; }\\nexport default App;\\n\`;
    return \`${"${imports}"}\\nexport {};\\n\`;
  };
  __context.exportConst("initialize", async () => undefined);
  __context.exportConst("formatMessages", async (messages = []) => messages.map((message) => message?.text || String(message)));
  __context.exportConst("transform", async (source, options = {}) => ({
    code: options.loader === "jsx" || options.loader === "tsx" || /<[A-Za-z][\\s\\S]*>/.test(source) ? transformJsxModule(String(source)) : String(source),
    map: null,
    warnings: []
  }));
  __context.exportConst("version", "browser-native-shim");
}`);
    continue;
  }
  if (definition.kind === "cjs-source") {
    const body = prepareCjsSourceForStaticFactory(source);
    validateCjsFactory(body, filename);
    cjsFactories.push(`${JSON.stringify(filename)}: (__context, __globals) => {
  const { exports, module, require, filename: __filename, dirname: __dirname } = __context;
  const __process = __globals.process;
  const __global = __globals.global;
  const __globalThis = __globals.globalThis;
  const __console = __globals.console;
  const __Buffer = __globals.Buffer;
  const __dynamicImport = __globals.__dynamicImport;
  const __setTimeout = __global.setTimeout;
  const __clearTimeout = __global.clearTimeout;
  const __setInterval = __global.setInterval;
  const __clearInterval = __global.clearInterval;
  const __setImmediate = __global.setImmediate;
  const __clearImmediate = __global.clearImmediate;
${indent(body, 2)}
}`);
    continue;
  }
  let body = prepareEsmStaticFactoryBody(source, filename);
  if (filename === `${projectRoot}/node_modules/vite/bin/vite.js`) {
    const original = "} else {\n  start()\n}";
    assert.equal(body.split(original).length - 1, 1, "unexpected Vite bin start expression");
    body = body.replace(original, "} else {\n  await start()\n}");
  }
  if (filename === `${projectRoot}/node_modules/vite/dist/node/cli.js`) {
    const original = "cli.parse();";
    assert.equal(body.split(original).length - 1, 1, "unexpected Vite CLI parse expression");
    body = body.replace(original, "cli.parse(undefined, { run: false });\nawait cli.runMatchedCommand();");
  }
  if (!validateEsmFactory(body)) {
    excluded.push(filename);
    delete sourceHashes[filename];
    continue;
  }
  esmFactories.push(`${JSON.stringify(filename)}: async (__context, __globals) => {
  const __process = __globals.process;
  const __global = __globals.global;
  const __console = __globals.console;
  const __globalThis = __globals.globalThis;
${indent(body, 2)}
}`);
}

assert.deepEqual(excluded, [`${projectRoot}/node_modules/rolldown/dist/experimental-runtime-base.mjs`]);

const outputRoot = path.join(repositoryRoot, `packages/workspace-runtime/assets/vendor/vite-${viteVersion}`);
fs.mkdirSync(outputRoot, { recursive: true });
const bindingRoot = resolvePackageRoot(nodeModulesRoot, `@rolldown/binding-wasm32-wasi`, rolldownVersion);
await build({
  base: `/vendor/vite-${viteVersion}/`,
  configFile: false,
  publicDir: false,
  root: bindingRoot,
  plugins: [{
    name: "nuriteo-rolldown-wasi-static-url",
    enforce: "pre",
    transform(source, id) {
      if (id !== path.join(bindingRoot, "rolldown-binding.wasi-browser.js")) return null;
      const expression = "new URL('./rolldown-binding.wasm32-wasi.wasm', import.meta.url).href";
      assert.equal(source.split(expression).length - 1, 1, "unexpected Rolldown WASI URL expression");
      return source.replace(expression, JSON.stringify(`/vendor/vite-${viteVersion}/assets/rolldown-binding.wasm`));
    }
  }],
  build: {
    assetsInlineLimit: 0,
    emptyOutDir: true,
    lib: {
      entry: path.join(bindingRoot, "rolldown-binding.wasi-browser.js"),
      fileName: "rolldown-wasi-binding",
      formats: ["es"]
    },
    outDir: outputRoot,
    sourcemap: false,
    target: "es2022",
    rollupOptions: {
      output: {
        assetFileNames: "assets/[name]-[hash][extname]",
        chunkFileNames: "assets/[name]-[hash].mjs",
        entryFileNames: "rolldown-wasi-binding.mjs"
      }
    }
  }
});
fs.copyFileSync(
  path.join(bindingRoot, "rolldown-binding.wasm32-wasi.wasm"),
  path.join(outputRoot, "assets/rolldown-binding.wasm")
);

const factoryPath = path.join(outputRoot, "vite-cli-static-factories.mjs");
const factorySource = normalizeGeneratedWhitespace(`// Generated from the pinned Vite ${viteVersion} dependency closure. Do not edit by hand.
import * as rolldownWasiBinding from "./rolldown-wasi-binding.mjs";

export const fixtureRevision = ${JSON.stringify(fixtureRevision)};
export const viteVersion = ${JSON.stringify(viteVersion)};
export const rolldownVersion = ${JSON.stringify(rolldownVersion)};
export const sourceSha256 = Object.freeze(${JSON.stringify(sourceHashes, null, 2)});
export const excludedModules = Object.freeze(${JSON.stringify(excluded)});
export function mountWorkspaceIntoRolldownWasi(snapshot) {
  const fs = rolldownWasiBinding.__fs;
  if (!fs || typeof fs.mkdirSync !== "function" || typeof fs.writeFileSync !== "function") {
    throw new Error("ERR_ROLLDOWN_WASI_FS_UNAVAILABLE");
  }
  if (typeof fs.rmSync === "function") fs.rmSync("/workspace", { recursive: true, force: true });
  for (const directory of snapshot.directories) fs.mkdirSync(directory, { recursive: true });
  for (const file of snapshot.files) {
    const binary = atob(file.data);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    fs.writeFileSync(file.path, bytes);
  }
  if (typeof fs.symlinkSync === "function") {
    for (const link of snapshot.links) {
      try { fs.symlinkSync(link.target, link.path); } catch {}
    }
  }
}
export function readRolldownWasiDirectory(root) {
  const fs = rolldownWasiBinding.__fs;
  if (!fs || typeof fs.readdirSync !== "function" || typeof fs.readFileSync !== "function") {
    throw new Error("ERR_ROLLDOWN_WASI_FS_UNAVAILABLE");
  }
  if (!fs.existsSync(root)) return [];
  const files = [];
  const visit = (directory) => {
    for (const name of fs.readdirSync(directory)) {
      const child = directory === "/" ? "/" + name : directory + "/" + name;
      const stat = fs.statSync(child);
      if (stat.isDirectory()) visit(child);
      else if (stat.isFile()) files.push({ path: child, data: new Uint8Array(fs.readFileSync(child)) });
    }
  };
  visit(root);
  return files;
}
export const cjsFactories = Object.freeze({
${indent(cjsFactories.join(",\n"), 2)}
});
export const esmFactories = Object.freeze({
${indent(esmFactories.join(",\n"), 2)}
});
`);
fs.writeFileSync(factoryPath, factorySource);

const files = walkFiles(outputRoot).map((file) => ({
  path: path.relative(repositoryRoot, file),
  bytes: fs.statSync(file).size,
  sha256: sha256(fs.readFileSync(file))
}));
process.stdout.write(`${JSON.stringify({
  cjsFactoryCount: cjsFactories.length,
  dependencyArtifactCount: dependencyArtifacts.length,
  esmFactoryCount: esmFactories.length,
  excluded,
  files
}, null, 2)}\n`);

function resolvePackageRoot(root: string, name: string, version: string): string {
  const direct = path.join(root, name);
  if (fs.existsSync(direct)) return fs.realpathSync(direct);
  const encoded = name.replace("/", "+");
  const pnpmEntry = fs.readdirSync(path.join(root, ".pnpm")).find((entry) => entry.startsWith(`${encoded}@${version}`));
  if (!pnpmEntry) throw new Error(`Missing ${name}@${version}`);
  return fs.realpathSync(path.join(root, ".pnpm", pnpmEntry, "node_modules", name));
}

function validateCjsFactory(body: string, filename: string): void {
  try {
    new Function("exports", "require", "module", "__filename", "__dirname", "__process", "__global", "__console", "__globalThis", "__Buffer", "__dynamicImport", "__setTimeout", "__clearTimeout", "__setInterval", "__clearInterval", "__setImmediate", "__clearImmediate", body);
  } catch (error) {
    throw new SyntaxError(`Invalid generated CommonJS factory for ${filename}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function validateEsmFactory(body: string): boolean {
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as typeof Function;
  try {
    new AsyncFunction("__context", "__process", "__global", "__console", "__globalThis", body);
    return true;
  } catch {
    return false;
  }
}

function indent(value: string, spaces: number): string {
  const prefix = " ".repeat(spaces);
  return value.split("\n").map((line) => `${prefix}${line}`).join("\n");
}

function normalizeGeneratedWhitespace(value: string): string {
  return value.split("\n").map((line) => {
    const indent = line.match(/^[ \t]*/)?.[0] || "";
    return `${indent.replaceAll("\t", "  ")}${line.slice(indent.length)}`.trimEnd();
  }).join("\n");
}

function sha256(value: crypto.BinaryLike): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function walkFiles(root: string): string[] {
  const output: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const child = path.join(root, entry.name);
    if (entry.isDirectory()) output.push(...walkFiles(child));
    else output.push(child);
  }
  return output.sort();
}
