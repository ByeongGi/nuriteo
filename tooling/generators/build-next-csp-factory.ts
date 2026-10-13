#!/usr/bin/env node
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs, { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import path, { dirname } from "node:path";

import { createNextDependencyArtifactFromWorkspace, createNextPackageArtifactFromWorkspace, NextProductWorkflow } from "../../packages/node-runtime/src/frameworks/next-workflow.ts";
import { prepareCjsSourceForStaticFactory } from "../../packages/node-runtime/src/modules/cjs.ts";
import { prepareEsmStaticFactoryBody } from "../../packages/node-runtime/src/modules/esm.ts";
import { createWorkspaceModuleRuntime } from "../../packages/node-runtime/src/modules/index.ts";
import { analyzeCliModuleGraph } from "../../packages/node-runtime/src/package-managers/cli-module-graph.ts";
import { createNodeFsWorkspaceReader } from "../shared/fs-workspace-reader.ts";

const repositoryRoot = path.resolve(new URL("../..", import.meta.url).pathname);
const require = createRequire(import.meta.url);
const nextVersion = "15.5.26";
const nextRoot = dirname(realpathSync(require.resolve("next/package.json")));
const requireFromNext = createRequire(`${nextRoot}/package.json`);
const nextManifest = JSON.parse(fs.readFileSync(path.join(nextRoot, "package.json"), "utf8")) as { version: string };
assert.equal(nextManifest.version, nextVersion);

const dependencyNames = [
  "@next/env", "@next/swc-wasm-nodejs", "@swc/helpers", "caniuse-lite", "client-only", "nanoid",
  "picocolors", "postcss", "react", "react-dom", "scheduler", "source-map-js", "styled-jsx", "typescript"
];
const packageRoot = (name: string): string => {
  try { return dirname(realpathSync(require.resolve(`${name}/package.json`))); } catch {
    try { return dirname(realpathSync(requireFromNext.resolve(`${name}/package.json`))); } catch {
      return dirname(realpathSync(require.resolve(name)));
    }
  }
};

const nextPackageArtifact = createNextPackageArtifactFromWorkspace({
  packageRoot: "/vendor/next",
  reader: createNodeFsWorkspaceReader({ root: nextRoot, virtualRoot: "/vendor/next" })
});
const dependencyArtifacts = dependencyNames.map((name) => createNextDependencyArtifactFromWorkspace({
  name,
  packageRoot: "/vendor/dependency",
  reader: createNodeFsWorkspaceReader({ root: packageRoot(name), virtualRoot: "/vendor/dependency" })
}));
const workflow = new NextProductWorkflow({ dependencyArtifacts, manager: "pnpm", nextPackageArtifact, port: 3045 });
workflow.install();

const projectRoot = "/workspace/app";
const entry = `${projectRoot}/node_modules/next/dist/bin/next`;
const graph = analyzeCliModuleGraph({ entry, packageRoot: `${projectRoot}/node_modules/next`, reader: workflow.workspace, maxModules: 16_384 });
const runtime = createWorkspaceModuleRuntime({ reader: workflow.workspace, root: "/workspace" });
const sourceSha256: Record<string, string> = {};
const cjsFactories: string[] = [];
const esmFactories: string[] = [];
const excluded: string[] = [];
const modulePaths = new Set(graph.modules.map((module) => module.path));
modulePaths.add(`${projectRoot}/node_modules/styled-jsx/style.js`);
modulePaths.add(`${projectRoot}/node_modules/next/dist/compiled/acorn/acorn.js`);
modulePaths.add(`${projectRoot}/node_modules/next/dist/compiled/loader-runner/LoaderRunner.js`);
modulePaths.add(`${projectRoot}/node_modules/next/dist/compiled/neo-async/async.js`);
modulePaths.add(`${projectRoot}/node_modules/next/dist/compiled/webpack/webpack-lib.js`);
modulePaths.add(`${projectRoot}/node_modules/next/dist/compiled/regenerator-runtime/runtime.js`);
modulePaths.add(`${projectRoot}/node_modules/next/dist/compiled/@next/react-refresh-utils/dist/loader.js`);
for (const file of workflow.workspace.snapshot().files) {
  if (file.path.startsWith(`${projectRoot}/node_modules/caniuse-lite/`) && file.path.endsWith(".js")) modulePaths.add(file.path);
  if (file.path.startsWith(`${projectRoot}/node_modules/@next/swc-wasm-nodejs/`) && file.path.endsWith(".js")) modulePaths.add(file.path);
  if (file.path.startsWith(`${projectRoot}/node_modules/next/dist/build/webpack/loaders/`) && file.path.endsWith(".js")) modulePaths.add(file.path);
}
const pendingResolvedModules = [...modulePaths];
for (let index = 0; index < pendingResolvedModules.length; index += 1) {
  const importer = pendingResolvedModules[index];
  const definition = runtime.getDefinition(importer);
  if (!definition || (definition.kind !== "cjs-source" && definition.kind !== "esm-source")) continue;
  const source = workflow.workspace.readText(importer);
  for (const match of source.matchAll(/\brequire(?:\.resolve)?\(\s*(['"`])([^'"`$]+)\1/g)) {
    try {
      const resolved = runtime.resolve(match[2], importer);
      if (!modulePaths.has(resolved)) {
        modulePaths.add(resolved);
        pendingResolvedModules.push(resolved);
      }
    } catch {}
  }
}

for (const filename of [...modulePaths].sort()) {
  const definition = runtime.getDefinition(filename);
  if (!definition || (definition.kind !== "cjs-source" && definition.kind !== "esm-source")) continue;
  const source = workflow.workspace.readText(filename);
  sourceSha256[filename] = sha256(source);
  if (definition.kind === "cjs-source") {
    const runtimeSource = transformRelativeDynamicImports(source);
    const factorySource = filename === entry
      ? transformNextCliEntry(runtimeSource)
      : filename.endsWith("/next/dist/server/require.js")
        ? transformNextServerRequire(runtimeSource)
      : filename.endsWith("/next/dist/build/webpack/config/blocks/base.js")
        ? transformNextWebpackBase(runtimeSource)
      : filename.endsWith("/next/dist/server/load-manifest.external.js")
        ? transformNextManifestLoader(runtimeSource)
      : filename.endsWith("/next/dist/server/config.js")
        ? transformNextConfigLoader(runtimeSource)
      : filename.endsWith("/next/dist/server/base-http/node.js")
        ? transformNextNodeResponse(runtimeSource)
      : filename.endsWith("/next/dist/server/web/sandbox/context.js")
        ? transformNextEdgeSandboxContext(runtimeSource)
      : filename.endsWith("/next/dist/server/web/sandbox/sandbox.js")
        ? transformNextEdgeSandboxRunner(runtimeSource)
      : filename.endsWith("/next/dist/compiled/@vercel/nft/index.js")
        ? transformNextNftBundle(runtimeSource)
      : filename.endsWith("/next/dist/compiled/@edge-runtime/primitives/index.js")
        ? "module.exports = { ...__global };"
        : filename.endsWith("/next/dist/compiled/edge-runtime/index.js")
          ? createBrowserEdgeRuntimeSource()
        : filename.endsWith("/next/dist/compiled/webpack/bundle5.js")
          ? transformWebpackBundle(runtimeSource)
          : filename.endsWith("/next/dist/compiled/conf/index.js") || filename.endsWith("/next/dist/compiled/schema-utils3/index.js")
            ? transformAjvBundle(runtimeSource)
            : filename.endsWith("/next/dist/compiled/send/index.js")
              ? transformSendBundle(runtimeSource)
              : filename.endsWith("/next/dist/build/swc/index.js")
                ? transformNextSwcLoader(runtimeSource)
              : filename.endsWith("/source-map-js/lib/quick-sort.js")
                ? transformSourceMapQuickSort(runtimeSource)
        : runtimeSource;
    const body = prepareCjsSourceForStaticFactory(factorySource);
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
  } else {
    const body = prepareEsmStaticFactoryBody(source, filename);
    if (!validateEsmFactory(body)) {
      excluded.push(filename);
      delete sourceSha256[filename];
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
}

assert.deepEqual(excluded, [], `All reachable Next CLI modules must have static factories: ${excluded.join(", ")}`);
const target = path.join(repositoryRoot, `packages/workspace-runtime/assets/vendor/next-cli-${nextVersion}.mjs`);
const output = normalizeGeneratedWhitespace(`// Generated from the pinned Next.js ${nextVersion} CLI dependency graph. Do not edit by hand.
export const nextVersion = ${JSON.stringify(nextVersion)};
export const sourceSha256 = Object.freeze(${JSON.stringify(sourceSha256, null, 2)});
export const graphIssues = Object.freeze(${JSON.stringify(graph.issues, null, 2)});
export const cjsFactories = Object.freeze({
${indent(cjsFactories.join(",\n"), 2)}
});
export const esmFactories = Object.freeze({
${indent(esmFactories.join(",\n"), 2)}
});
`);
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, output);
process.stdout.write(`${JSON.stringify({
  cjsFactoryCount: cjsFactories.length,
  esmFactoryCount: esmFactories.length,
  factorySha256: sha256(output),
  graphIssueCount: graph.issues.length,
  graphIssues: graph.issues,
  moduleCount: graph.modules.length,
  sourceCount: Object.keys(sourceSha256).length,
  target: path.relative(repositoryRoot, target)
}, null, 2)}\n`);

function validateCjsFactory(body: string, filename: string): void {
  try {
    new Function("exports", "require", "module", "__filename", "__dirname", "__process", "__global", "__console", "__globalThis", "__Buffer", "__dynamicImport", "__setTimeout", "__clearTimeout", "__setInterval", "__clearInterval", "__setImmediate", "__clearImmediate", body);
  } catch (error) {
    throw new SyntaxError(`Invalid generated CommonJS factory for ${filename}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function transformNextCliEntry(source: string): string {
  const parseCall = "program.parse(process.argv);";
  const devDispatch = "Promise.resolve(require('../cli/next-dev.js')).then((mod)=>mod.nextDev(options, portSource, directory));";
  assert.equal(source.split(parseCall).length - 1, 1, "Unexpected Next CLI parse call");
  const transformed = source
    .replace(/\bimport\((['"][^'"]+['"])\)/g, "Promise.resolve(require($1))")
    .replace(devDispatch, `return ${devDispatch}`)
    .replace(parseCall, "global.__nuriteoCliReady = program.parseAsync(process.argv);");
  assert.equal(transformed.split(`return ${devDispatch}`).length - 1, 1, "Unexpected Next dev dispatch");
  return transformed;
}

function transformRelativeDynamicImports(source: string): string {
  return source.replace(/\bimport\((['"])(\.{1,2}\/[^'"]+)\1\)/g, "Promise.resolve(require($1$2$1))");
}

function transformNextServerRequire(source: string): string {
  const original = "const mod = process.env.NEXT_MINIMAL ? __non_webpack_require__(pagePath) : require(pagePath);";
  const replacement = "const mod = process.env.NEXT_MINIMAL ? __non_webpack_require__(pagePath) : await global.__nuriteoImportGeneratedModule(pagePath);";
  assert.equal(source.split(original).length - 1, 1, "Unexpected Next server requirePage implementation");
  return source.replace(original, replacement);
}

function transformNextWebpackBase(source: string): string {
  const original = "config.devtool = 'eval-source-map';";
  assert.equal(source.split(original).length - 1, 1, "Unexpected Next development devtool implementation");
  return source.replace(original, "config.devtool = false;");
}

function transformNextManifestLoader(source: string): string {
  const original = `let contextObject = {};
    (0, _vm.runInNewContext)(content, contextObject);`;
  const replacement = `const prefix = 'globalThis.__RSC_MANIFEST=(globalThis.__RSC_MANIFEST||{});globalThis.__RSC_MANIFEST[';
    if (!content.startsWith(prefix)) {
        throw new Error('ERR_NEXT_CSP_UNSUPPORTED_MANIFEST_SCRIPT');
    }
    const assignmentIndex = content.indexOf(']=', prefix.length);
    if (assignmentIndex < 0) {
        throw new Error('ERR_NEXT_CSP_INVALID_MANIFEST_SCRIPT');
    }
    const entryName = JSON.parse(content.slice(prefix.length, assignmentIndex));
    const manifest = JSON.parse(content.slice(assignmentIndex + 2));
    let contextObject = { __RSC_MANIFEST: { [entryName]: manifest } };`;
  assert.equal(source.split(original).length - 1, 1, "Unexpected Next manifest evaluator implementation");
  return source.replace(original, replacement);
}

function transformNextConfigLoader(source: string): string {
  const original = "userConfigModule = await import((0, _url.pathToFileURL)(path).href);";
  assert.equal(source.split(original).length - 1, 1, "Unexpected Next config loader implementation");
  return source.replace(original, "userConfigModule = await global.__nuriteoImportWorkspaceModule(path);");
}

function transformNextEdgeSandboxContext(source: string): string {
  const original = `const evaluateInContext = (filepath)=>{
        if (!moduleContext.paths.has(filepath)) {
            const content = (0, _fs.readFileSync)(filepath, 'utf-8');
            try {
                (0, _vm.runInContext)(content, moduleContext.runtime.context, {
                    filename: filepath
                });
                moduleContext.paths.set(filepath, content);
            } catch (error) {
                if (options.useCache) {
                    moduleContext == null ? void 0 : moduleContext.paths.delete(filepath);
                }
                throw error;
            }
        }
    };`;
  const replacement = `const evaluateInContext = async (filepath)=>{
        if (!moduleContext.paths.has(filepath)) {
            try {
                await global.__nuriteoImportEdgeModule(filepath, moduleContext.runtime.context);
                moduleContext.paths.set(filepath, filepath);
            } catch (error) {
                if (options.useCache) {
                    moduleContext == null ? void 0 : moduleContext.paths.delete(filepath);
                }
                throw error;
            }
        }
    };`;
  assert.equal(source.split(original).length - 1, 1, "Unexpected Next Edge sandbox evaluator");
  return source.replace(original, replacement);
}

function transformNextEdgeSandboxRunner(source: string): string {
  const original = "evaluateInContext(paramPath);";
  assert.equal(source.split(original).length - 1, 1, "Unexpected Next Edge sandbox runner");
  return source.replace(original, "await evaluateInContext(paramPath);");
}

function transformNextNodeResponse(source: string): string {
  const original = `    send() {
        this._res.end(this.textBody);
    }
    onClose(callback) {`;
  const replacement = `    send() {
        this._res.end(this.textBody);
    }
    write(chunk, encoding, callback) {
        return this._res.write(chunk, encoding, callback);
    }
    end(chunk, encoding, callback) {
        this._res.end(chunk, encoding, callback);
        return this;
    }
    onClose(callback) {`;
  assert.equal(source.split(original).length - 1, 1, "Unexpected Next NodeNextResponse implementation");
  return source.replace(original, replacement);
}

function createBrowserEdgeRuntimeSource(): string {
  return `class EdgeRuntime {
    constructor(options = {}) {
      const context = Object.create(__global);
      Object.assign(context, { Array, ArrayBuffer, Boolean, Date, Error, JSON, Map, Math, Number, Object, Promise, RegExp, Set, String, Symbol, Uint8Array, WeakMap, WeakSet, WebAssembly });
      context.globalThis = context;
      context.self = context;
      context.global = context;
      context.addEventListener = __global.addEventListener?.bind(__global) || (() => undefined);
      context.removeEventListener = __global.removeEventListener?.bind(__global) || (() => undefined);
      context.dispatchEvent = __global.dispatchEvent?.bind(__global) || (() => true);
      this.context = typeof options.extend === "function" ? options.extend(context) : context;
    }
    evaluate(expression) {
      if (expression === "Error") return Error;
      if (expression === "Uint8Array") return Uint8Array;
      throw new Error("ERR_NEXT_CSP_UNSUPPORTED_EDGE_EVALUATION: " + expression);
    }
  }
  module.exports = { EdgeRuntime, VM: EdgeRuntime };
  `;
}

function transformNextNftBundle(source: string): string {
  const evalRequireCount = source.split('eval("require")').length - 1;
  assert.ok(evalRequireCount >= 5, "Unexpected @vercel/nft dynamic require implementation");
  return source
    .replaceAll('eval("require.resolve(basePath)")', "require.resolve(basePath)")
    .replaceAll('eval("require.resolve(resolvedPath)")', "require.resolve(resolvedPath)")
    .replaceAll('eval("require")', "require");
}

function transformWebpackBundle(source: string): string {
  const dynamicCompiler = "const be=new Function(ge);return be()";
  const staticSearch = `return function dispatchBinarySearch(a,y,c,l,h){
    const custom=typeof c==="function";
    let low=custom?(l===void 0?0:l|0):(c===void 0?0:c|0);
    let high=custom?(h===void 0?a.length-1:h|0):(l===void 0?a.length-1:l|0);
    let found=I?low-1:high+1;
    while(low<=high){
      const middle=(low+high)>>>1;
      const value=a[middle];
      const compared=custom?c(value,y):(value===y?0:value<y?-1:1);
      if(R==="EQ"){
        if(compared===0)return middle;
        if(compared<0)low=middle+1;else high=middle-1;
      }else if(R==="GE"||R==="GT"){
        if(compared>0||(R==="GE"&&compared===0)){found=middle;high=middle-1;}else low=middle+1;
      }else{
        if(compared<0||(R==="LE"&&compared===0)){found=middle;low=middle+1;}else high=middle-1;
      }
    }
    return R==="EQ"?-1:found;
  }`;
  assert.equal(source.split(dynamicCompiler).length - 1, 1, "Unexpected webpack binary-search compiler");
  const withoutBinarySearchCompiler = source
    .replace(dynamicCompiler, staticSearch)
    .replaceAll('R.runInContext(`(function(){return {${I}};})()`,this.magicCommentContext)', 'global.__nuriteoParseWebpackMagicComment(I)')
    .replaceAll('K.runInContext(`(function(){return {${I}};})()`,this.magicCommentContext)', 'global.__nuriteoParseWebpackMagicComment(I)');
  assert.equal(withoutBinarySearchCompiler.includes('runInContext(`(function(){return {${I}};})()`'), false, "Webpack magic comments still use VM evaluation");
  const factoryStart = withoutBinarySearchCompiler.indexOf("class HookCodeFactory{");
  const createStart = withoutBinarySearchCompiler.indexOf("create(v){", factoryStart);
  const setupStart = withoutBinarySearchCompiler.indexOf("setup(v,I){", createStart);
  assert.ok(factoryStart >= 0 && createStart > factoryStart && setupStart > createStart, "Unexpected Tapable hook compiler");
  const staticCreate = `create(v){
    this.init(v);
    const kind=this.constructor.name;
    const taps=v.taps.slice();
    const interceptors=v.interceptors.slice();
    const needsContext=taps.some((tap)=>tap.context)||interceptors.some((interceptor)=>interceptor.context);
    const notify=(name,value,context)=>{for(const interceptor of interceptors){const handler=interceptor[name];if(handler)handler.call(interceptor,interceptor.context?context:value,...(interceptor.context&&value!==undefined?[value]:[]));}};
    const before=(args,context)=>{for(const interceptor of interceptors){if(interceptor.call)interceptor.call(...(interceptor.context?[context,...args]:args));}};
    const beforeTap=(tap,context)=>{for(const interceptor of interceptors){if(interceptor.tap)interceptor.tap(...(interceptor.context?[context,tap]:[tap]));}};
    const invokeSync=(tap,args,context)=>{beforeTap(tap,context);const fn=tap.fn;return fn(...(tap.context?[context,...args]:args));};
    const invokeAsync=(tap,args,context)=>{beforeTap(tap,context);const fn=tap.fn;try{if(tap.type==="async")return new Promise((resolve,reject)=>fn(...(tap.context?[context,...args]:args),((error,result)=>error?reject(error):resolve(result))));const result=fn(...(tap.context?[context,...args]:args));if(tap.type==="promise"&&(!result||typeof result.then!=="function"))throw new Error("Tap function (tapPromise) did not return promise (returned "+result+")");return Promise.resolve(result);}catch(error){return Promise.reject(error);}};
    const finish=(result,context)=>{if(kind.includes("Waterfall")||result!==undefined)notify("result",result,context);else notify("done",undefined,context);return result;};
    const fail=(error,context)=>{notify("error",error,context);throw error;};
    const runSync=(args)=>{const context=needsContext?{}:undefined;before(args,context);try{if(kind.includes("Loop")){let looping;do{looping=false;for(const tap of taps){if(invokeSync(tap,args,context)!==undefined){looping=true;break;}}}while(looping);return finish(undefined,context);}let result;for(const tap of taps){const value=invokeSync(tap,args,context);if(kind.includes("Waterfall")&&value!==undefined){args[0]=value;result=value;}else if(kind.includes("Bail")&&value!==undefined){return finish(value,context);}}return finish(kind.includes("Waterfall")?args[0]:result,context);}catch(error){return fail(error,context);}};
    const runAsync=async(args)=>{const context=needsContext?{}:undefined;before(args,context);try{if(kind.includes("Parallel")){if(kind.includes("Bail"))return await new Promise((resolve,reject)=>{if(taps.length===0){resolve(finish(undefined,context));return;}let pending=taps.length;let settled=false;for(const tap of taps)invokeAsync(tap,args,context).then((value)=>{if(settled)return;if(value!==undefined){settled=true;resolve(finish(value,context));}else if(--pending===0){settled=true;resolve(finish(undefined,context));}},(error)=>{if(!settled){settled=true;try{fail(error,context);}catch(caught){reject(caught);}}});});await Promise.all(taps.map((tap)=>invokeAsync(tap,args,context)));return finish(undefined,context);}if(kind.includes("Loop")){let looping;do{looping=false;for(const tap of taps){if(await invokeAsync(tap,args,context)!==undefined){looping=true;break;}}}while(looping);return finish(undefined,context);}let result;for(const tap of taps){const value=await invokeAsync(tap,args,context);if(kind.includes("Waterfall")&&value!==undefined){args[0]=value;result=value;}else if(kind.includes("Bail")&&value!==undefined){return finish(value,context);}}return finish(kind.includes("Waterfall")?args[0]:result,context);}catch(error){return fail(error,context);}};
    let compiled;
    if(v.type==="sync")compiled=function(...args){return runSync(args)};
    else if(v.type==="async")compiled=function(...args){const callback=args.pop();runAsync(args).then((result)=>callback(null,result),(error)=>callback(error))};
    else compiled=function(...args){return runAsync(args)};
    this.deinit();
    return compiled;
  }`;
  const withoutTapableCompiler = `${withoutBinarySearchCompiler.slice(0, createStart)}${staticCreate}${withoutBinarySearchCompiler.slice(setupStart)}`;
  return `const process=__process;\n${withoutTapableCompiler}`;
}

function transformAjvBundle(source: string): string {
  const start = source.indexOf("var _=new Function(");
  const suffix = ";p[0]=w";
  const end = source.indexOf(suffix, start);
  assert.ok(start >= 0 && end > start, "Unexpected bundled Ajv compiler");
  assert.equal(source.indexOf("var _=new Function(", start + 1), -1, "Multiple bundled Ajv compilers");
  return `${source.slice(0, start)}w=function(){w.errors=null;return true}${source.slice(end + suffix.length)}`;
}

function transformSendBundle(source: string): string {
  const start = source.indexOf("var r=new Function(");
  const suffix = ";return r";
  const end = source.indexOf(suffix, start);
  assert.ok(start >= 0 && end > start, "Unexpected bundled send deprecation wrapper");
  return `${source.slice(0, start)}var deprecate=this;var r=function(){log.call(deprecate,t,n);return e.apply(this,arguments)}${source.slice(end)}`;
}

function transformSourceMapQuickSort(source: string): string {
  const dynamicClone = `function cloneSort(comparator) {
  let template = SortTemplate.toString();
  let templateFn = new Function(\`return \${template}\`)();
  return templateFn(comparator);
}`;
  assert.equal(source.split(dynamicClone).length - 1, 1, "Unexpected source-map quick-sort compiler");
  return source.replace(dynamicClone, "function cloneSort(comparator) { return SortTemplate(comparator); }");
}

function transformNextSwcLoader(source: string): string {
  const dynamicImport = "await import((0, _url.pathToFileURL)(pkgPath).toString())";
  assert.equal(source.split(dynamicImport).length - 1, 1, "Unexpected Next SWC WASM import");
  return source.replace(dynamicImport, "await Promise.resolve(require(pkgPath))");
}

function validateEsmFactory(body: string): boolean {
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as typeof Function;
  try { new AsyncFunction("__context", "__process", "__global", "__console", "__globalThis", body); return true; } catch { return false; }
}

function indent(value: string, spaces: number): string {
  const prefix = " ".repeat(spaces);
  return value.split("\n").map((line) => `${prefix}${line}`).join("\n");
}

function normalizeGeneratedWhitespace(value: string): string {
  return value.split("\n").map((line) => {
    const whitespace = line.match(/^[ \t]*/)?.[0] || "";
    return `${whitespace.replaceAll("\t", "  ")}${line.slice(whitespace.length)}`.trimEnd();
  }).join("\n");
}

function sha256(value: crypto.BinaryLike): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}
