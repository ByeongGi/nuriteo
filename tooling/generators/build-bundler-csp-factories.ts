#!/usr/bin/env node
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { createRequire } from "node:module";
import ts from "typescript";

import { prepareCjsSourceForStaticFactory } from "../../packages/node-runtime/src/modules/cjs.ts";
import { prepareEsmStaticFactoryBody } from "../../packages/node-runtime/src/modules/esm.ts";

type Lane = "webpack" | "rspack";
interface PackageNode {
  dependencies: Map<string, PackageNode>;
  manifest: PackageJson;
  realRoot: string;
}
interface PackageJson {
  bin?: string | Record<string, string>;
  dependencies?: Record<string, string>;
  main?: string;
  name: string;
  optionalDependencies?: Record<string, string>;
  type?: string;
  version: string;
}
interface Placement { node: PackageNode; virtualRoot: string }

const repositoryRoot = path.resolve(new URL("../..", import.meta.url).pathname);
const projectRoot = "/workspace/project";
const lanes: Record<Lane, { roots: string[]; version: string }> = {
  webpack: { roots: ["webpack", "webpack-cli", "webpack-dev-server"], version: "5.111.0" },
  rspack: { roots: ["@rspack/core", "@rspack/cli", "@rspack/dev-server", "@rspack/binding-wasm32-wasi"], version: "2.2.4" }
};
const selected = process.argv.slice(2) as Lane[];
const requested = selected.length ? selected : Object.keys(lanes) as Lane[];
for (const lane of requested) {
  if (!(lane in lanes)) throw new Error(`Unknown bundler lane: ${lane}`);
  buildLane(lane);
}

function buildLane(lane: Lane): void {
  const config = lanes[lane];
  const nodes = new Map<string, PackageNode>();
  const rootNodes = config.roots.map((name) => loadPackage(name, repositoryRoot, nodes));
  for (const [index, root] of rootNodes.entries()) assert.equal(root.manifest.name, config.roots[index]);
  assert.equal(rootNodes[0]!.manifest.version, config.version);

  const defaultByName = new Map<string, PackageNode>();
  for (const node of rootNodes) defaultByName.set(node.manifest.name, node);
  for (const node of nodes.values()) if (!defaultByName.has(node.manifest.name)) defaultByName.set(node.manifest.name, node);

  const placements = new Map<string, Placement>();
  for (const node of defaultByName.values()) place(node, virtualPackageRoot(node.manifest.name), placements, defaultByName, []);

  const files: { path: string; data: string; encoding: "base64" }[] = [];
  const sourceSha256: Record<string, string> = {};
  const cjsFactories: string[] = [];
  const esmFactories: string[] = [];
  const skipped: string[] = [];
  for (const { node, virtualRoot } of [...placements.values()].sort((a, b) => a.virtualRoot.localeCompare(b.virtualRoot))) {
    for (const sourceFile of walkFiles(node.realRoot)) {
      const relative = path.relative(node.realRoot, sourceFile).replaceAll(path.sep, "/");
      if (!includePackageFile(relative)) continue;
      const virtualPath = `${virtualRoot}/${relative}`;
      let bytes = fs.readFileSync(sourceFile);
      if (lane === "rspack" && virtualPath === `${projectRoot}/node_modules/@rspack/dev-server/client/index.js`) {
        let clientSource = bytes.toString("utf8");
        const emitterImport = "import hotEmitter from '@rspack/core/hot/emitter.js';";
        const logImport = "import webpackHotLog from '@rspack/core/hot/log.js';";
        assert.equal(clientSource.split(emitterImport).length - 1, 1, "unexpected Rspack HMR emitter import");
        assert.equal(clientSource.split(logImport).length - 1, 1, "unexpected Rspack HMR log import");
        clientSource = clientSource
          .replace(emitterImport, "import { emitter as hotEmitter } from '@rspack/core/hot/emitter.js';")
          .replace(logImport, "import * as webpackHotLog from '@rspack/core/hot/log.js';");
        bytes = Buffer.from(clientSource);
      }
      files.push({ path: virtualPath, data: bytes.toString("base64"), encoding: "base64" });
      if (!/\.(?:cjs|mjs|js)$/.test(relative) && !isExtensionlessBin(relative, node.manifest)) continue;
      const source = bytes.toString("utf8");
      sourceSha256[virtualPath] = sha256(bytes);
      if (lane === "rspack" && virtualPath === `${projectRoot}/node_modules/@rspack/binding-wasm32-wasi/rspack.wasi-browser.js`) continue;
      const packageType = nearestPackageType(sourceFile, node.realRoot, node.manifest.type);
      const esm = relative.endsWith(".mjs")
        || (relative.endsWith(".js") && packageType === "module")
        || (relative.endsWith(".js") && relative.includes(".esm."))
        || (relative.endsWith(".js") && /^\s*(?:import|export)\s/m.test(source));
      if (esm) {
        let factorySource = source;
        if (lane === "rspack" && virtualPath === `${projectRoot}/node_modules/@rspack/cli/bin/rspack.js`) {
          const expression = "runCLI().catch((err) => {";
          assert.equal(factorySource.split(expression).length - 1, 1, "unexpected rspack CLI run expression");
          factorySource = factorySource.replace(expression, "await runCLI().catch((err) => {");
        }
        if (lane === "rspack" && virtualPath === `${projectRoot}/node_modules/@rspack/cli/dist/index.js`) {
          const expression = `compiler.run((error, stats)=>{
        compiler.close((closeErr)=>{
            if (closeErr) logger.error(closeErr);
            errorHandler(error, stats);
        });
    });`;
          assert.equal(factorySource.split(expression).length - 1, 1, "unexpected rspack build callback expression");
          factorySource = factorySource.replace(expression, `await new Promise((resolveBuild) => compiler.run((error, stats)=>{
        compiler.close((closeErr)=>{
            if (closeErr) logger.error(closeErr);
            errorHandler(error, stats);
            resolveBuild();
        });
    }));`);
        }
        try {
          const body = prepareEsmStaticFactoryBody(factorySource, virtualPath);
          validateEsmFactory(body, virtualPath);
          esmFactories.push(renderEsmFactory(virtualPath, body));
        } catch (error) {
          try {
            const cjsCompatibleSource = factorySource
              .replace(/\bimport\.meta\.dirname\b/g, "__dirname")
              .replace(/\bimport\.meta\.filename\b/g, "__filename")
              .replace(/\bimport\.meta\.url\b/g, "require('node:url').pathToFileURL(__filename).href");
            const transpiled = ts.transpileModule(cjsCompatibleSource, {
              compilerOptions: {
                allowJs: true,
                esModuleInterop: true,
                module: ts.ModuleKind.CommonJS,
                target: ts.ScriptTarget.ES2022
              },
              fileName: `${virtualPath}.ts`
            }).outputText;
            const body = prepareValidatedCjsBody(transpiled, virtualPath);
            cjsFactories.push(renderCjsFactory(virtualPath, body));
          } catch (fallbackError) {
            skipped.push(`${virtualPath}: ${error instanceof Error ? error.message : String(error)}; CommonJS fallback: ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`);
          }
        }
      } else {
        let factorySource = source;
        if (lane === "webpack" && virtualPath === `${projectRoot}/node_modules/webpack-dev-server/lib/Server.js`) {
          const validation = `    validate(/** @type {Schema} */ (schema), options, {
      name: "Dev Server",
      baseDataPath: "options",
    });`;
          assert.equal(factorySource.split(validation).length - 1, 1, "unexpected webpack-dev-server validation call");
          factorySource = factorySource.replace(validation, "    // Options are produced by the pinned CLI and validated by its static parser.");
        }
        if (lane === "webpack" && virtualPath === `${projectRoot}/node_modules/webpack-dev-server/lib/servers/WebsocketServer.js`) {
          const webSocketServer = "new WebSocket.Server(options)";
          assert.equal(factorySource.split(webSocketServer).length - 1, 1, "unexpected webpack-dev-server WebSocket constructor");
          factorySource = factorySource.replace(webSocketServer, `new (require("${projectRoot}/node_modules/ws/index.js").Server)(options)`);
          const upgrade = `        this.implementation.handleUpgrade(req, sock, head, (connection) => {
          this.implementation.emit("connection", connection, req);
        });`;
          assert.equal(factorySource.split(upgrade).length - 1, 1, "unexpected webpack-dev-server WebSocket upgrade");
          factorySource = factorySource.replace(upgrade, `        this.implementation.emit("connection", sock, req);`);
        }
        if (lane === "webpack" && virtualPath === `${projectRoot}/node_modules/webpack/lib/util/binarySearchBounds.js`) {
          const dynamicCompiler = `\t// eslint-disable-next-line no-new-func
\tconst result = new Function(fnSource);
\treturn result();`;
          assert.equal(factorySource.split(dynamicCompiler).length - 1, 1, "unexpected webpack binary search compiler");
          factorySource = factorySource.replace(dynamicCompiler, `\treturn (items, needle, compare, low, high) => {
\t\tlet left = low === undefined ? 0 : low | 0;
\t\tlet right = high === undefined ? items.length - 1 : high | 0;
\t\tlet found = reversed ? left - 1 : right + 1;
\t\twhile (left <= right) {
\t\t\tconst middle = (left + right) >>> 1;
\t\t\tconst value = items[middle];
\t\t\tconst order = typeof compare === "function" ? compare(value, needle) : value < needle ? -1 : value > needle ? 1 : 0;
\t\t\tif (suffix === "EQ" && order === 0) return middle;
\t\t\tconst matches = suffix === "GE" ? order >= 0 : suffix === "GT" ? order > 0 : suffix === "LE" ? order <= 0 : suffix === "LT" ? order < 0 : false;
\t\t\tif (matches) {
\t\t\t\tfound = middle;
\t\t\t\tif (reversed) left = middle + 1;
\t\t\t\telse right = middle - 1;
\t\t\t} else if (reversed) right = middle - 1;
\t\t\telse left = middle + 1;
\t\t}
\t\treturn suffix === "EQ" ? -1 : found;
\t};`);
        }
        if (lane === "webpack" && virtualPath.endsWith("/node_modules/tapable/lib/HookCodeFactory.js")) {
          const createStart = factorySource.indexOf("\tcreate(options) {");
          const setupStart = factorySource.indexOf("\n\tsetup(instance, options)", createStart);
          assert.ok(createStart >= 0 && setupStart > createStart, "unexpected tapable hook factory shape");
          const staticCreate = `\tcreate(options) {
\t\tconst kind = this.constructor.name.replace(/CodeFactory$/, "");
\t\tconst runTap = (hook, tap, index, args, context) => {
\t\t\tfor (const interceptor of hook.interceptors) interceptor.tap?.(interceptor.context ? context : tap, ...(interceptor.context ? [tap] : []));
\t\t\tconst invokeArgs = tap.context ? [context, ...args] : args;
\t\t\tif (tap.type === "sync") return hook._x[index](...invokeArgs);
\t\t\tif (tap.type === "promise") {
\t\t\t\tconst promise = hook._x[index](...invokeArgs);
\t\t\t\tif (!promise?.then) throw new Error("Tap function (tapPromise) did not return promise");
\t\t\t\treturn promise;
\t\t\t}
\t\t\treturn new Promise((resolve, reject) => hook._x[index](...invokeArgs, (error, value) => error ? reject(error) : resolve(value)));
\t\t};
\t\tconst notifyCall = (hook, args, context) => {
\t\t\tfor (const interceptor of hook.interceptors) interceptor.call?.(...(interceptor.context ? [context, ...args] : args));
\t\t};
\t\tconst notifyDone = (hook) => { for (const interceptor of hook.interceptors) interceptor.done?.(); };
\t\tconst notifyResult = (hook, result) => { for (const interceptor of hook.interceptors) interceptor.result?.(result); };
\t\tconst notifyError = (hook, error) => { for (const interceptor of hook.interceptors) interceptor.error?.(error); };
\t\tconst notifyLoop = (hook, value) => { for (const interceptor of hook.interceptors) interceptor.loop?.(value); };
\t\tconst runSync = (hook, args) => {
\t\t\tconst context = {};
\t\t\tnotifyCall(hook, args, context);
\t\t\ttry {
\t\t\t\tif (kind === "SyncWaterfallHook") {
\t\t\t\t\tlet current = args[0];
\t\t\t\t\tfor (let index = 0; index < options.taps.length; index++) {
\t\t\t\t\t\tconst result = runTap(hook, options.taps[index], index, [current, ...args.slice(1)], context);
\t\t\t\t\t\tif (result !== undefined) current = result;
\t\t\t\t\t}
\t\t\t\t\tnotifyResult(hook, current);
\t\t\t\t\treturn current;
\t\t\t\t}
\t\t\t\tif (kind === "SyncLoopHook") {
\t\t\t\t\tfor (let index = 0; index < options.taps.length;) {
\t\t\t\t\t\tconst result = runTap(hook, options.taps[index], index, args, context);
\t\t\t\t\t\tif (result !== undefined) { notifyLoop(hook, result); index = 0; } else index++;
\t\t\t\t\t}
\t\t\t\t\tnotifyDone(hook);
\t\t\t\t\treturn;
\t\t\t\t}
\t\t\t\tfor (let index = 0; index < options.taps.length; index++) {
\t\t\t\t\tconst result = runTap(hook, options.taps[index], index, args, context);
\t\t\t\t\tif (kind === "SyncBailHook" && result !== undefined) { notifyResult(hook, result); return result; }
\t\t\t\t}
\t\t\t\tnotifyDone(hook);
\t\t\t} catch (error) { notifyError(hook, error); throw error; }
\t\t};
\t\tconst runAsync = async (hook, args) => {
\t\t\tconst context = {};
\t\t\tnotifyCall(hook, args, context);
\t\t\ttry {
\t\t\t\tif (kind.startsWith("AsyncParallel")) {
\t\t\t\t\tconst results = await Promise.all(options.taps.map((tap, index) => runTap(hook, tap, index, args, context)));
\t\t\t\t\tif (kind === "AsyncParallelBailHook") {
\t\t\t\t\t\tconst result = results.find((value) => value !== undefined);
\t\t\t\t\t\tif (result !== undefined) { notifyResult(hook, result); return result; }
\t\t\t\t\t}
\t\t\t\t\tnotifyDone(hook);
\t\t\t\t\treturn;
\t\t\t\t}
\t\t\t\tlet current = args[0];
\t\t\t\tfor (let index = 0; index < options.taps.length;) {
\t\t\t\t\tconst tapArgs = kind === "AsyncSeriesWaterfallHook" ? [current, ...args.slice(1)] : args;
\t\t\t\t\tconst result = await runTap(hook, options.taps[index], index, tapArgs, context);
\t\t\t\t\tif (kind === "AsyncSeriesBailHook" && result !== undefined) { notifyResult(hook, result); return result; }
\t\t\t\t\tif (kind === "AsyncSeriesWaterfallHook" && result !== undefined) current = result;
\t\t\t\t\tif (kind === "AsyncSeriesLoopHook" && result !== undefined) { notifyLoop(hook, result); index = 0; } else index++;
\t\t\t\t}
\t\t\t\tif (kind === "AsyncSeriesWaterfallHook") { notifyResult(hook, current); return current; }
\t\t\t\tnotifyDone(hook);
\t\t\t} catch (error) { notifyError(hook, error); throw error; }
\t\t};
\t\tif (options.type === "sync") return function(...args) { return runSync(this, args); };
\t\tif (options.type === "promise") return function(...args) { return runAsync(this, args); };
\t\treturn function(...args) {
\t\t\tconst callback = args.pop();
\t\t\trunAsync(this, args).then((result) => callback(null, result), (error) => callback(error));
\t\t};
\t}`;
          factorySource = `${factorySource.slice(0, createStart)}${staticCreate}${factorySource.slice(setupStart)}`;
        }
        if (lane === "rspack" && virtualPath === `${projectRoot}/node_modules/@rspack/dev-server/dist/server.js`) {
          const validation = `        (0, schema_utils_1.validate)(options_json_1.default, options, {
            name: 'Dev Server',
            baseDataPath: 'options',
        });`;
          assert.equal(factorySource.split(validation).length - 1, 1, "unexpected rspack-dev-server validation call");
          factorySource = factorySource.replace(validation, "        // Options are produced by the pinned CLI and validated by its static parser.");
          const hostnameGuard = `        if (hostname === null) {
            return false;
        }`;
          assert.equal(factorySource.split(hostnameGuard).length - 1, 1, "unexpected rspack-dev-server hostname guard");
          const protocolGuard = `        if (DEFAULT_ALLOWED_PROTOCOLS.test(header)) {
            return true;
        }`;
          assert.equal(factorySource.split(protocolGuard).length - 1, 1, "unexpected rspack-dev-server protocol guard");
          factorySource = factorySource
            .replace(protocolGuard, `${protocolGuard}
        if (/^(?:https?:\\/\\/)?(?:\\d{1,3}\\.){3}\\d{1,3}(?::\\d+)?$/.test(header)) return true;`)
            .replace(hostnameGuard, `${hostnameGuard}
        if (/^(?:\\d{1,3}\\.){3}\\d{1,3}$/.test(hostname)) return true;`);
          const sameOrigin = "    isSameOrigin(headers) {";
          assert.equal(factorySource.split(sameOrigin).length - 1, 1, "unexpected rspack-dev-server same-origin method");
          factorySource = factorySource.replace(sameOrigin, `${sameOrigin}
        if (headers.origin === \`http://\${headers.host}\` || headers.origin === \`https://\${headers.host}\`) return true;`);
        }
        if (lane === "rspack" && virtualPath === `${projectRoot}/node_modules/@rspack/dev-server/dist/servers/WebsocketServer.js`) {
          const webSocketServer = "new ws_1.default.Server(options)";
          assert.equal(factorySource.split(webSocketServer).length - 1, 1, "unexpected rspack-dev-server WebSocket constructor");
          factorySource = factorySource.replace(webSocketServer, `new (require("${projectRoot}/node_modules/ws/index.js").Server)(options)`);
          const upgrade = `            this.implementation.handleUpgrade(req, sock, head, (connection) => {
                this.implementation.emit('connection', connection, req);
            });`;
          assert.equal(factorySource.split(upgrade).length - 1, 1, "unexpected rspack-dev-server WebSocket upgrade");
          factorySource = factorySource.replace(upgrade, "            this.implementation.emit('connection', sock, req);");
        }
        if (virtualPath.endsWith("/node_modules/webpack-dev-middleware/dist/index.js")) {
          const validation = `  validate(/** @type {Schema} */schema, options, {
    name: "Dev Middleware",
    baseDataPath: "options"
  });`;
          assert.equal(factorySource.split(validation).length - 1, 1, "unexpected webpack-dev-middleware validation call");
          factorySource = factorySource.replace(validation, "  // Options are produced by the pinned dev server and require no runtime code generation.");
          const filledContext = "  const filledContext = /** @type {FilledContext<RequestInternal, ResponseInternal>} */";
          assert.equal(factorySource.split(filledContext).length - 1, 1, "unexpected webpack-dev-middleware filled context");
          factorySource = factorySource.replace(filledContext, `  __bundlerInvalidate = (path) => {
    context.compiler.inputFileSystem?.purge?.(path);
    if (typeof context.watching.invalidateWithChangesAndRemovals === "function") {
      context.watching.invalidateWithChangesAndRemovals(new Set([path]), new Set());
    } else {
      context.watching._collectedChangedFiles = new Set([path]);
      context.watching.invalidate();
    }
  };\n${filledContext}`);
        }
        if (virtualPath.endsWith("/node_modules/webpack-dev-middleware/dist/middleware.js")) {
          const errorHandler = "    async function errorHandler(error) {";
          assert.equal(factorySource.split(errorHandler).length - 1, 1, "unexpected webpack-dev-middleware error handler");
          factorySource = factorySource.replace(errorHandler, `${errorHandler}\n      context.logger.error(error);`);
        }
        if (lane === "webpack" && virtualPath === `${projectRoot}/node_modules/webpack-cli/bin/cli.js`) {
          const expression = "runCLI(process.argv);";
          assert.equal(factorySource.split(expression).length - 1, 1, "unexpected webpack-cli run expression");
          factorySource = factorySource.replace(expression, "module.exports = runCLI(process.argv);");
          const errorHandler = "cli.logger.error(error);\n    process.exit(2);";
          assert.equal(factorySource.split(errorHandler).length - 1, 1, "unexpected webpack-cli error handler");
          factorySource = factorySource.replace(errorHandler, "throw error;");
        }
        const body = prepareValidatedCjsBody(factorySource, virtualPath);
        cjsFactories.push(renderCjsFactory(virtualPath, body));
      }
    }
  }

  const outputRoot = path.join(repositoryRoot, `packages/workspace-runtime/assets/vendor/${lane}-${config.version}`);
  fs.mkdirSync(outputRoot, { recursive: true });
  const snapshot = {
    directories: ["/", "/workspace", projectRoot, `${projectRoot}/node_modules`],
    files: files.sort((a, b) => a.path.localeCompare(b.path)),
    links: []
  };
  const snapshotBytes = zlib.gzipSync(Buffer.from(JSON.stringify(snapshot)), { level: 9 });
  const snapshotPath = path.join(outputRoot, "package-workspace.bin");
  fs.writeFileSync(snapshotPath, snapshotBytes);

  const imports = lane === "rspack"
    ? `import * as rspackWasiBinding from "./rspack-wasi-binding.mjs";\n`
    : "";
  const rspackOverride = lane === "rspack"
    ? `\nconst __rspackBindingPath = ${JSON.stringify(`${projectRoot}/node_modules/@rspack/binding-wasm32-wasi/rspack.wasi.cjs`)};
const __rspackBrowserBindingPath = ${JSON.stringify(`${projectRoot}/node_modules/@rspack/binding-wasm32-wasi/rspack.wasi-browser.js`)};
const __rspackBindingFactory = (__context) => {
  const binding = rspackWasiBinding.default || rspackWasiBinding;
  __context.module.exports = Object.assign({}, binding, { __esModule: false });
};
cjsFactories[__rspackBindingPath] = __rspackBindingFactory;
cjsFactories[__rspackBrowserBindingPath] = __rspackBindingFactory;
export function mountWorkspaceIntoRspackWasi(snapshot) {
  const fs = rspackWasiBinding.__fs;
  if (!fs) throw new Error("ERR_RSPACK_WASI_FS_UNAVAILABLE");
  if (typeof fs.rmSync === "function") fs.rmSync("/workspace", { recursive: true, force: true });
  for (const directory of snapshot.directories) fs.mkdirSync(directory, { recursive: true });
  for (const file of snapshot.files) {
    const binary = atob(file.data);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    fs.writeFileSync(file.path, bytes);
  }
}
export function writeRspackWasiFile(path, data) {
  const fs = rspackWasiBinding.__fs;
  if (!fs) throw new Error("ERR_RSPACK_WASI_FS_UNAVAILABLE");
  const parent = path.slice(0, path.lastIndexOf("/")) || "/";
  fs.mkdirSync(parent, { recursive: true });
  fs.writeFileSync(path, typeof data === "string" ? data : new Uint8Array(data));
}
export function readRspackWasiDirectory(root) {
  const fs = rspackWasiBinding.__fs;
  if (!fs?.existsSync(root)) return [];
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
}\n`
    : "";
  const factorySource = normalizeGeneratedText(`// Generated from integrity-pinned ${lane} ${config.version} packages. Do not edit.\n${imports}
export const bundler = ${JSON.stringify(lane)};
export const version = ${JSON.stringify(config.version)};
export const packageVersions = Object.freeze(${JSON.stringify(Object.fromEntries([...defaultByName].map(([name, node]) => [name, node.manifest.version]).sort()), null, 2)});
export const sourceSha256 = Object.freeze(${JSON.stringify(sourceSha256, null, 2)});
export const snapshotSha256 = ${JSON.stringify(sha256(snapshotBytes))};
export const skippedModules = Object.freeze(${JSON.stringify(skipped, null, 2)});
let __bundlerInvalidate = null;
export const cjsFactories = {
${indent(cjsFactories.join(",\n"), 2)}
};
export const esmFactories = Object.freeze({
${indent(esmFactories.join(",\n"), 2)}
});
${rspackOverride}
export function invalidateBundler(path) { __bundlerInvalidate?.(path); }
Object.freeze(cjsFactories);
`);
  const factoryPath = path.join(outputRoot, "cli-static-factories.mjs");
  fs.writeFileSync(factoryPath, factorySource);
  const manifest = {
    bundler: lane,
    version: config.version,
    packages: defaultByName.size,
    placements: placements.size,
    workspaceFiles: files.length,
    cjsFactories: cjsFactories.length,
    esmFactories: esmFactories.length,
    skippedModules: skipped,
    assets: {
      factory: { bytes: Buffer.byteLength(factorySource), sha256: sha256(factorySource) },
      workspace: { bytes: snapshotBytes.byteLength, sha256: sha256(snapshotBytes) }
    }
  };
  fs.writeFileSync(path.join(outputRoot, "factory-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
}

function loadPackage(name: string, from: string, nodes: Map<string, PackageNode>): PackageNode {
  const require = createRequire(path.join(from, "__nuriteo_resolve.cjs"));
  let manifestPath: string;
  try {
    manifestPath = require.resolve(`${name}/package.json`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ERR_PACKAGE_PATH_NOT_EXPORTED") throw error;
    let current = path.dirname(require.resolve(name));
    for (;;) {
      const candidate = path.join(current, "package.json");
      if (fs.existsSync(candidate) && (JSON.parse(fs.readFileSync(candidate, "utf8")) as PackageJson).name === name) {
        manifestPath = candidate;
        break;
      }
      const parent = path.dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
  const realRoot = fs.realpathSync(path.dirname(manifestPath));
  const existing = nodes.get(realRoot);
  if (existing) return existing;
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as PackageJson;
  const node: PackageNode = { dependencies: new Map(), manifest, realRoot };
  nodes.set(realRoot, node);
  for (const dependency of Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies }).sort()) {
    try {
      node.dependencies.set(dependency, loadPackage(dependency, realRoot, nodes));
    } catch (error) {
      if (!(dependency in (manifest.optionalDependencies || {}))) throw error;
    }
  }
  return node;
}

function place(node: PackageNode, virtualRoot: string, placements: Map<string, Placement>, defaults: Map<string, PackageNode>, ancestors: PackageNode[]): void {
  const key = `${node.realRoot}\0${virtualRoot}`;
  if (placements.has(key)) return;
  placements.set(key, { node, virtualRoot });
  for (const dependency of node.dependencies.values()) {
    if (defaults.get(dependency.manifest.name) === dependency) continue;
    if (ancestors.includes(dependency)) continue;
    place(dependency, `${virtualRoot}/node_modules/${dependency.manifest.name}`, placements, defaults, [...ancestors, node]);
  }
}

function virtualPackageRoot(name: string): string { return `${projectRoot}/node_modules/${name}`; }
function includePackageFile(relative: string): boolean {
  if (relative.includes("/node_modules/")) return false;
  if (/\.(?:d\.(?:ts|mts|cts)|map|md|markdown|node)$/i.test(relative)) return false;
  if (/(?:^|\/)(?:test|tests|__tests__|docs|example|examples|benchmark|benchmarks)(?:\/|$)/i.test(relative)) return false;
  return true;
}
function isExtensionlessBin(relative: string, manifest: PackageJson): boolean {
  const bins = typeof manifest.bin === "string" ? [manifest.bin] : Object.values(manifest.bin || {});
  return bins.some((bin) => bin.replace(/^\.\//, "") === relative);
}
function nearestPackageType(sourceFile: string, packageRoot: string, fallback?: string): string | undefined {
  let directory = path.dirname(sourceFile);
  while (directory.startsWith(packageRoot)) {
    const manifestPath = path.join(directory, "package.json");
    if (fs.existsSync(manifestPath)) {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Pick<PackageJson, "type">;
      return manifest.type;
    }
    if (directory === packageRoot) break;
    directory = path.dirname(directory);
  }
  return fallback;
}
function walkFiles(root: string): string[] {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(root, entry.name);
    return entry.isDirectory() ? walkFiles(file) : entry.isFile() ? [file] : [];
  });
}
function renderCjsFactory(filename: string, body: string): string {
  const contextBindings = [
    ["exports", "__runtimeExports", "let"], ["module", "__runtimeModule", "const"], ["require", "__runtimeRequire", "const"],
    ["__filename", "__runtimeFilename", "const"], ["__dirname", "__runtimeDirname", "const"]
  ].map(([name, runtimeName, declaration]) => declaresBinding(body, name!) ? "" : `${declaration} ${name} = ${runtimeName};`).filter(Boolean).join("\n  ");
  const globalBindings = [
    ["process", "__process"], ["global", "__global"], ["globalThis", "__globalThis"], ["console", "__console"], ["Buffer", "__Buffer"],
    ["setTimeout", "__setTimeout"], ["clearTimeout", "__clearTimeout"], ["setInterval", "__setInterval"], ["clearInterval", "__clearInterval"],
    ["setImmediate", "__setImmediate"], ["clearImmediate", "__clearImmediate"]
  ].map(([name, runtimeName]) => declaresBinding(body, name!) ? "" : `const ${name} = ${runtimeName};`).filter(Boolean).join("\n  ");
  const rendered = `${JSON.stringify(filename)}: (__context, __globals) => {
  const { exports: __runtimeExports, module: __runtimeModule, require: __runtimeRequire, filename: __runtimeFilename, dirname: __runtimeDirname } = __context;
  ${contextBindings}
  const __process = __globals.process; const __global = __globals.global; const __globalThis = __globals.globalThis;
  const __console = __globals.console; const __Buffer = __globals.Buffer; const __dynamicImport = (specifier) => __globals.__dynamicImport(specifier, __runtimeFilename);
  const __setTimeout = __global.setTimeout; const __clearTimeout = __global.clearTimeout;
  const __setInterval = __global.setInterval; const __clearInterval = __global.clearInterval;
  const __setImmediate = __global.setImmediate; const __clearImmediate = __global.clearImmediate;
  ${globalBindings}
${indent(body, 2)}
}`;
  try { new Function(`return ({${rendered}});`); }
  catch (error) { throw new SyntaxError(`Invalid rendered CommonJS factory for ${filename}: ${error instanceof Error ? error.message : String(error)}`); }
  return rendered;
}
function renderEsmFactory(filename: string, body: string): string {
  return `${JSON.stringify(filename)}: async (__context, __globals) => {
  const __process = __globals.process; const __global = __globals.global; const __globalThis = __globals.globalThis; const __console = __globals.console;
${indent(body, 2)}
}`;
}
function validateCjsFactory(body: string, filename: string): void {
  try { new Function("exports", "require", "module", "__runtimeFilename", "__runtimeDirname", "__process", "__global", "__console", "__globalThis", "__Buffer", "__dynamicImport", "__setTimeout", "__clearTimeout", "__setInterval", "__clearInterval", "__setImmediate", "__clearImmediate", body); }
  catch (error) { throw new SyntaxError(`Invalid generated CommonJS factory for ${filename}: ${error instanceof Error ? error.message : String(error)}`); }
}
function prepareValidatedCjsBody(source: string, filename: string): string {
  let body = prepareCjsSourceForStaticFactory(source);
  body = body.replace(/^(?:const (?:process|global|globalThis|console|Buffer|setTimeout|clearTimeout|setInterval|clearInterval|setImmediate|clearImmediate) = __[^;]+;\n)+/, "");
  for (const name of ["process", "global", "globalThis", "console", "Buffer", "setTimeout", "clearTimeout", "setInterval", "clearInterval", "setImmediate", "clearImmediate"]) {
    try {
      validateCjsFactory(body, filename);
      return body;
    } catch (error) {
      if (!(error instanceof SyntaxError) || !error.message.includes(`Identifier '${name}' has already been declared`)) continue;
      body = body.replace(`const ${name} = __${name === "Buffer" ? "Buffer" : name};\n`, "");
    }
  }
  validateCjsFactory(body, filename);
  return body;
}
function validateEsmFactory(body: string, filename: string): void {
  try { Object.getPrototypeOf(async function () {}).constructor("__context", "__globals", body); }
  catch (error) { throw new SyntaxError(`Invalid generated ESM factory for ${filename}: ${error instanceof Error ? error.message : String(error)}`); }
}
function declaresBinding(source: string, name: string): boolean {
  const file = ts.createSourceFile("factory.cjs", source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
  for (const statement of file.statements) {
    if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name?.text === name) return true;
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (bindingNameContains(declaration.name, name)) return true;
      }
    }
  }
  let functionScopedVar = false;
  const visit = (node: ts.Node): void => {
    if (functionScopedVar) return;
    if (node !== file && ts.isFunctionLike(node)) return;
    if (ts.isVariableDeclaration(node)
      && ts.isVariableDeclarationList(node.parent)
      && (node.parent.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) === 0
      && bindingNameContains(node.name, name)) {
      functionScopedVar = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return functionScopedVar;
}
function bindingNameContains(binding: ts.BindingName, name: string): boolean {
  if (ts.isIdentifier(binding)) return binding.text === name;
  return binding.elements.some((element) => !ts.isOmittedExpression(element) && bindingNameContains(element.name, name));
}
function indent(value: string, spaces: number): string { const prefix = " ".repeat(spaces); return value.split("\n").map((line) => `${prefix}${line}`).join("\n"); }
function normalizeGeneratedText(value: string): string {
  const normalized = value
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line
      .replace(/^[\t ]+/, (indentation) => indentation.replace(/ +(?=\t)/g, ""))
      .replace(/[\t ]+$/g, ""))
    .join("\n");
  return normalized.endsWith("\n") ? normalized : `${normalized}\n`;
}
function sha256(value: crypto.BinaryLike): string { return crypto.createHash("sha256").update(value).digest("hex"); }
