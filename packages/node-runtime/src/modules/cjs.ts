import type { ModuleRuntime } from "./runtime.ts";
import { evaluateEsmSync } from "./esm.ts";
import { transpileTypeScript } from "../transforms/typescript.ts";
import type { CjsContext, RuntimeModule, RuntimeNamespace, RuntimeValue } from "../types.ts";

export function evaluateCjs(runtime: ModuleRuntime, url: string): RuntimeValue {
  const canonicalUrl = runtime.cache.canonicalize(url);
  const cached = runtime.cache.cjs.get(canonicalUrl);
  if (cached) return cached.exports;

  const definition = runtime.getDefinition(canonicalUrl);
  if (!definition) {
    throw new Error(`ERR_REQUIRE_ESM_OR_MISSING: ${canonicalUrl}`);
  }
  if (definition.kind === "esm" || definition.kind === "esm-source") {
    try {
      return evaluateEsmSync(runtime, canonicalUrl);
    } catch (error) {
      if (!runtime.allowAsyncRequireEsm || !isRequireAsyncModuleError(error)) throw error;
      runtime.cache.esm.delete(canonicalUrl);
      const pending = runtime.importModule(canonicalUrl);
      const record = runtime.cache.esm.get(canonicalUrl);
      pending.catch(() => undefined);
      return createPendingEsmNamespaceProxy(record?.namespace || {}, runtime);
    }
  }

  const module: RuntimeModule = {
    id: canonicalUrl,
    exports: {},
    loaded: false
  };
  runtime.cache.cjs.set(canonicalUrl, module);

  if (definition.kind === "json") {
    module.exports = definition.value;
    module.loaded = true;
    return module.exports;
  }

  const dirname = canonicalUrl.slice(0, canonicalUrl.lastIndexOf("/")) || "/";
  const require = createCjsRequire(runtime, canonicalUrl, dirname);
  const factory = definition.kind === "cjs"
    ? definition.factory
    : compileCjsSource(runtime, definition.source, canonicalUrl, runtime.globals);
  factory({
    exports: module.exports,
    module,
    require,
    filename: canonicalUrl,
    dirname
  });
  module.loaded = true;
  return module.exports;
}

function isRequireAsyncModuleError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("ERR_REQUIRE_ASYNC_MODULE");
}

function createPendingEsmNamespaceProxy(namespace: RuntimeNamespace, runtime: ModuleRuntime): RuntimeNamespace {
  const knownProperties = new Set<PropertyKey>(Reflect.ownKeys(namespace));
  const placeholder = function AsyncEsmBindingPlaceholder() {};
  Object.defineProperty(placeholder.prototype, "getOrder", {
    configurable: true,
    value: () => undefined
  });
  Object.defineProperty(placeholder.prototype, "close", {
    configurable: true,
    value: async () => undefined
  });
  Object.defineProperty(placeholder.prototype, "scan", {
    configurable: true,
    value: async () => undefined
  });
  Object.defineProperty(placeholder.prototype, "write", {
    configurable: true,
    value: async () => ({ assets: [], chunks: [] })
  });
  return new Proxy(namespace, {
    defineProperty(target, property, descriptor) {
      knownProperties.add(property);
      return Reflect.defineProperty(target, property, descriptor);
    },
    get(target, property, receiver) {
      if (property === "__esModule") return true;
      if (property === "enhancedTransformSync" || property === "transformSync") return browserTransformSyncFallback;
      if (property === "BindingBundler") return createBindingBundlerPlaceholder(runtime);
      if (property === "BindingCallableBuiltinPlugin") return createBindingCallableBuiltinPluginPlaceholder(runtime);
      const value = Reflect.get(target, property, receiver);
      if (value !== undefined) return value;
      return typeof property === "string" ? placeholder : value;
    },
    getOwnPropertyDescriptor(target, property) {
      knownProperties.add(property);
      if (property === "enhancedTransformSync" || property === "transformSync") {
        return {
          configurable: true,
          enumerable: true,
          get: () => browserTransformSyncFallback
        };
      }
      if (property === "BindingCallableBuiltinPlugin") {
        return {
          configurable: true,
          enumerable: true,
          get: () => createBindingCallableBuiltinPluginPlaceholder(runtime)
        };
      }
      if (property === "BindingBundler") {
        return {
          configurable: true,
          enumerable: true,
          get: () => createBindingBundlerPlaceholder(runtime)
        };
      }
      return Reflect.getOwnPropertyDescriptor(target, property) || {
        configurable: true,
        enumerable: true,
        get: () => {
          if (property === "enhancedTransformSync" || property === "transformSync") return browserTransformSyncFallback;
          return Reflect.get(target, property) ?? (property === "BindingCallableBuiltinPlugin" ? createBindingCallableBuiltinPluginPlaceholder(runtime) : placeholder);
        }
      };
    },
    ownKeys(target) {
      return [...new Set([...Reflect.ownKeys(target), ...knownProperties])]
        .filter((property): property is string | symbol => typeof property !== "number");
    },
    set(_target, property) {
      knownProperties.add(property);
      return true;
    }
  });
}

function createBindingBundlerPlaceholder(runtime: ModuleRuntime): new () => RuntimeNamespace {
  return function BindingBundler() {
    return {
      closed: false,
      close: async () => undefined,
      generate: async (bundlerOptions: RuntimeNamespace = {}) => createBrowserBuildOutput(runtime, bundlerOptions, false),
      getWatchFiles: () => [],
      scan: async (bundlerOptions: RuntimeNamespace) => {
        debugAsyncEsmBinding("BindingBundler.scan");
        await runBrowserBindingScan(runtime, bundlerOptions);
        return {};
      },
      write: async (bundlerOptions: RuntimeNamespace = {}) => createBrowserBuildOutput(runtime, bundlerOptions, true)
    };
  } as unknown as new () => RuntimeNamespace;
}

function createBrowserBuildOutput(runtime: ModuleRuntime, bundlerOptions: RuntimeNamespace, writeFiles: boolean): { assets: RuntimeNamespace[]; chunks: RuntimeNamespace[] } {
  const inputOptions = (bundlerOptions.inputOptions || {}) as RuntimeNamespace;
  const outputOptions = (bundlerOptions.outputOptions || {}) as RuntimeNamespace;
  const cwd = typeof inputOptions.cwd === "string" ? normalizePosixPath(inputOptions.cwd) : "/workspace/project";
  const outDir = typeof outputOptions.dir === "string" ? resolveBuildPath(cwd, outputOptions.dir) : dirnameOf(resolveBuildPath(cwd, typeof outputOptions.file === "string" ? outputOptions.file : "dist/index.js"));
  const entry = firstBuildInput(inputOptions.input, cwd);
  const fs = runtime.builtins?.("node:fs") as {
    mkdirSync?: (path: string) => void;
    readFileSync?: (path: string, encoding: "utf8") => string;
    writeFileSync?: (path: string, data: string) => void;
  } | undefined;
  const sourcePath = resolveHtmlEntryScript(fs, entry, cwd) || entry;
  const source = readOptionalText(fs, sourcePath) || "";
  const code = source ? transformBrowserSupportedSource(sourcePath, source) : "";
  const chunkFileName = "assets/index.js";
  const html = createBuildHtml(fs, entry, chunkFileName);
  if (writeFiles) {
    tryWriteBuildFile(fs, outDir, "index.html", html);
    tryWriteBuildFile(fs, `${outDir}/assets`, "index.js", code || "export {};\n");
  }
  return {
    assets: [createBrowserBuildAsset("index.html", html)],
    chunks: [createBrowserBuildChunk(chunkFileName, sourcePath, code || "export {};\n")]
  };
}

function tryWriteBuildFile(
  fs: { mkdirSync?: (path: string) => void; writeFileSync?: (path: string, data: string) => void } | undefined,
  directory: string,
  fileName: string,
  data: string
): void {
  try {
    fs?.mkdirSync?.(directory);
    fs?.writeFileSync?.(`${directory}/${fileName}`, data);
  } catch {
    // Some evaluator modes expose read-only fs bindings; the output object is still useful there.
  }
}

function firstBuildInput(input: RuntimeValue, cwd: string): string {
  if (Array.isArray(input)) {
    const first = input[0] as { import?: unknown } | undefined;
    if (typeof first?.import === "string") return resolveBuildPath(cwd, first.import);
  }
  if (input && typeof input === "object") {
    const entries = Object.values(input as Record<string, { import?: unknown }>);
    const first = entries[0];
    if (typeof first?.import === "string") return resolveBuildPath(cwd, first.import);
  }
  return `${cwd}/index.html`;
}

function resolveHtmlEntryScript(
  fs: { readFileSync?: (path: string, encoding: "utf8") => string } | undefined,
  entry: string,
  cwd: string
): string | undefined {
  if (!entry.endsWith(".html")) return entry;
  const html = readOptionalText(fs, entry);
  const script = html?.match(/<script\b[^>]*\btype=["']module["'][^>]*\bsrc=["']([^"']+)["'][^>]*>/i)?.[1];
  if (!script) return undefined;
  return resolveBuildPath(dirnameOf(entry), script.startsWith("/") ? `${cwd}${script}` : script);
}

function createBuildHtml(fs: { readFileSync?: (path: string, encoding: "utf8") => string } | undefined, entry: string, chunkFileName: string): string {
  const fallback = `<div id="root"></div><script type="module" src="/${chunkFileName}"></script>\n`;
  if (!entry.endsWith(".html")) return fallback;
  const html = readOptionalText(fs, entry) || fallback;
  if (/<script\b[^>]*\btype=["']module["'][^>]*\bsrc=["'][^"']+["'][^>]*>/i.test(html)) {
    return html.replace(/<script\b([^>]*\btype=["']module["'][^>]*)\bsrc=["'][^"']+["']([^>]*)>/i, `<script$1src="/${chunkFileName}"$2>`);
  }
  return `${html.trimEnd()}<script type="module" src="/${chunkFileName}"></script>\n`;
}

function createBrowserBuildChunk(fileName: string, sourcePath: string, code: string): RuntimeNamespace {
  return {
    dropInner: () => ({ freed: true }),
    getCode: () => code,
    getDynamicImports: () => [],
    getExports: () => [],
    getFacadeModuleId: () => sourcePath,
    getFileName: () => fileName,
    getImports: () => [],
    getIsDynamicEntry: () => false,
    getIsEntry: () => true,
    getMap: () => undefined,
    getModuleIds: () => [sourcePath],
    getModules: () => ({ keys: [], values: [] }),
    getName: () => "index",
    getPreliminaryFileName: () => fileName,
    getSourcemapFileName: () => undefined
  };
}

function createBrowserBuildAsset(fileName: string, source: string): RuntimeNamespace {
  return {
    getFileName: () => fileName,
    getName: () => "index",
    getNames: () => ["index"],
    getOriginalFileName: () => undefined,
    getOriginalFileNames: () => [],
    getSource: () => source
  };
}

function readOptionalText(fs: { readFileSync?: (path: string, encoding: "utf8") => string } | undefined, path: string): string | undefined {
  try {
    return fs?.readFileSync?.(path, "utf8");
  } catch {
    return undefined;
  }
}

function resolveBuildPath(base: string, path: string): string {
  if (path.startsWith("/")) return normalizePosixPath(path);
  return normalizePosixPath(`${base}/${path}`);
}

async function runBrowserBindingScan(runtime: ModuleRuntime, bundlerOptions: RuntimeNamespace): Promise<void> {
  const fs = runtime.builtins?.("node:fs") as { readFileSync?: (path: string, encoding: "utf8") => string } | undefined;
  const plugins = Array.isArray(bundlerOptions.plugins) ? bundlerOptions.plugins as RuntimeNamespace[] : [];
  const visited = new Set<string>();
  for (const entry of normalizeScanInputs(bundlerOptions.input)) {
    await scanModule(entry, undefined);
  }

  async function scanModule(id: string, importer: string | undefined): Promise<void> {
    const resolved = await resolveScanId(id, importer);
    const moduleId = resolved?.id || id;
    if (resolved?.external || visited.has(moduleId)) return;
    visited.add(moduleId);

    const source = await loadScanModule(moduleId);
    if (source === undefined) return;

    for (const specifier of extractStaticImportSpecifiers(source)) {
      const child = await resolveScanId(specifier, moduleId);
      if (child?.external) continue;
      await scanModule(child?.id || normalizeRelativeScanId(specifier, moduleId), moduleId);
    }
  }

  async function loadScanModule(id: string): Promise<string | undefined> {
    for (const plugin of plugins) {
      const loaded = await callPluginHook(plugin.load, id);
      const code = extractPluginCode(loaded);
      if (code !== undefined) return code;
    }
    try {
      return fs?.readFileSync?.(id, "utf8");
    } catch {
      return undefined;
    }
  }

  async function resolveScanId(id: string, importer: string | undefined): Promise<{ id: string; external?: boolean } | undefined> {
    for (const plugin of plugins) {
      const resolved = await callPluginHook(plugin.resolveId, id, importer);
      if (!resolved) continue;
      if (typeof resolved === "string") return { id: resolved };
      if (typeof resolved === "object" && "id" in resolved && typeof resolved.id === "string") {
        return { id: resolved.id, external: (resolved as { external?: boolean }).external === true };
      }
    }
    return undefined;
  }
}

function normalizeScanInputs(input: RuntimeValue): string[] {
  if (typeof input === "string") return [input];
  if (Array.isArray(input)) return input.filter((value): value is string => typeof value === "string");
  if (input && typeof input === "object") {
    return Object.values(input as Record<string, RuntimeValue>).filter((value): value is string => typeof value === "string");
  }
  return [];
}

async function callPluginHook(hook: RuntimeValue, ...args: RuntimeValue[]): Promise<RuntimeValue> {
  if (typeof hook === "function") return hook(...args);
  if (hook && typeof hook === "object") {
    const handler = (hook as { handler?: RuntimeValue }).handler;
    if (typeof handler === "function") return handler(...args);
  }
  return undefined;
}

function extractPluginCode(value: RuntimeValue): string | undefined {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const code = (value as { code?: RuntimeValue }).code;
    if (typeof code === "string") return code;
  }
  return undefined;
}

function extractStaticImportSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const importPattern = /(?:^|[;\n])\s*import\s+(?:[\w*{}\n\r\t, ]+\s+from\s+)?["']([^"']+)["']/g;
  let match: RegExpExecArray | null;
  while ((match = importPattern.exec(source))) {
    const specifier = match[1];
    if (specifier) specifiers.push(specifier);
  }
  return specifiers;
}

function normalizeRelativeScanId(specifier: string, importer: string): string {
  if (!specifier.startsWith(".")) return specifier;
  return normalizePosixPath(`${dirnameOf(importer)}/${specifier}`);
}

function browserTransformSyncFallback(filename: string, sourceText: string): RuntimeNamespace {
  const code = transformBrowserSupportedSource(filename, sourceText);
  return {
    code,
    errors: [],
    map: null,
    tsconfigFilePaths: [],
    warnings: []
  };
}

function transformBrowserSupportedSource(filename: string, sourceText: string): string {
  const clean = filename.split("?")[0] || filename;
  if (!/\.(?:[cm]?tsx?|jsx)$/.test(clean)) return sourceText;
  if (/\.(?:[cm]?tsx?)$/.test(clean)) {
    return transpileTypeScript(sourceText, { fileName: clean }).code;
  }
  return sourceText;
}

function createBindingCallableBuiltinPluginPlaceholder(runtime: ModuleRuntime): new (bindingPlugin?: { __name?: string; options?: RuntimeNamespace }) => RuntimeNamespace {
  return function BindingCallableBuiltinPlugin(bindingPlugin?: { __name?: string; options?: RuntimeNamespace }) {
    debugAsyncEsmBinding(`BindingCallableBuiltinPlugin:${bindingPlugin?.__name || "<unknown>"}`);
    if (bindingPlugin?.__name === "builtin:vite-resolve") {
      return createViteResolveBuiltinPlugin(runtime, bindingPlugin.options || {});
    }
    return createEmptyCallableBuiltinPlugin();
  } as unknown as new (bindingPlugin?: { __name?: string; options?: RuntimeNamespace }) => RuntimeNamespace;
}

function createEmptyCallableBuiltinPlugin(): RuntimeNamespace {
  const plugin: RuntimeNamespace = {};
  Object.defineProperty(plugin, "getOrder", {
    configurable: true,
    value: () => undefined
  });
  Object.defineProperty(plugin, "close", {
    configurable: true,
    value: async () => undefined
  });
  Object.defineProperty(plugin, "scan", {
    configurable: true,
    value: async () => undefined
  });
  Object.defineProperty(plugin, "write", {
    configurable: true,
    value: async () => ({ assets: [], chunks: [] })
  });
  return plugin;
}

function debugAsyncEsmBinding(message: string): void {
  const debug = (globalThis as { process?: { env?: { DEBUG?: string } } }).process?.env?.DEBUG;
  if (!debug?.split(",").some((scope) => scope === "cargo:binding" || scope === "cargo:*")) return;
  console.error(`cargo:binding ${message}`);
}

function createViteResolveBuiltinPlugin(runtime: ModuleRuntime, options: RuntimeNamespace): RuntimeNamespace {
  const resolveOptions = options.resolveOptions as { root?: string } | undefined;
  const root = normalizePosixPath(resolveOptions?.root || "/workspace/project");
  const plugin: RuntimeNamespace = {
    async resolveId(id: string, importer?: string) {
      if (id.startsWith("\0") || id.startsWith("virtual:") || id.startsWith("/virtual:") || id.startsWith("__vite-")) return undefined;
      if (id.startsWith("/@") || id.startsWith("//")) return undefined;
      if (id.startsWith("/") && looksLikeProjectSource(id)) return { id: `${root}${id}` };
      if (id.startsWith(".") && importer && looksLikeProjectSource(id)) return { id: normalizePosixPath(`${dirnameOf(importer)}/${id}`) };
      const packageId = resolveBrowserPackageId(runtime, root, id);
      if (packageId) return { id: packageId };
      return undefined;
    }
  };
  Object.defineProperty(plugin, "getOrder", {
    configurable: true,
    value: () => undefined
  });
  return plugin;
}

function resolveBrowserPackageId(runtime: ModuleRuntime, root: string, specifier: string): string | undefined {
  if (!/^[\w@][^:]*$/.test(specifier)) return undefined;
  const fs = runtime.builtins?.("node:fs") as { readFileSync?: (path: string, encoding: "utf8") => string; statSync?: (path: string) => { isFile(): boolean } } | undefined;
  if (!fs?.readFileSync) return undefined;
  const { packageName, subpath } = splitPackageSpecifier(specifier);
  if (!packageName) return undefined;
  const packageRoot = `${root}/node_modules/${packageName}`;
  const manifest = readPackageManifest(fs, `${packageRoot}/package.json`);
  const exportTarget = resolvePackageExportTarget(manifest, subpath);
  const candidates = [
    exportTarget,
    subpath === "." ? manifest?.browser : undefined,
    subpath === "." ? manifest?.module : undefined,
    subpath === "." ? manifest?.main : undefined,
    subpath === "." ? "./index.js" : `${subpath}.js`,
    subpath === "." ? undefined : `${subpath}/index.js`
  ].filter((value): value is string => typeof value === "string");
  for (const candidate of candidates) {
    const resolved = normalizePosixPath(`${packageRoot}/${candidate.startsWith("./") ? candidate.slice(2) : candidate}`);
    if (fileExists(fs, resolved)) return resolved;
  }
  return undefined;
}

function splitPackageSpecifier(specifier: string): { packageName?: string; subpath: string } {
  const parts = specifier.split("/");
  if (specifier.startsWith("@")) {
    if (parts.length < 2) return { subpath: "." };
    return {
      packageName: `${parts[0]}/${parts[1]}`,
      subpath: parts.length > 2 ? `./${parts.slice(2).join("/")}` : "."
    };
  }
  const packageName = parts[0];
  if (!packageName) return { subpath: "." };
  return {
    packageName,
    subpath: parts.length > 1 ? `./${parts.slice(1).join("/")}` : "."
  };
}

function readPackageManifest(fs: { readFileSync?: (path: string, encoding: "utf8") => string }, path: string): { browser?: string; exports?: RuntimeValue; main?: string; module?: string } | undefined {
  try {
    return JSON.parse(fs.readFileSync?.(path, "utf8") || "{}") as { browser?: string; exports?: RuntimeValue; main?: string; module?: string };
  } catch {
    return undefined;
  }
}

function resolvePackageExportTarget(manifest: { exports?: RuntimeValue } | undefined, subpath: string): string | undefined {
  const exports = manifest?.exports;
  if (typeof exports === "string" && subpath === ".") return exports;
  if (!exports || typeof exports !== "object" || Array.isArray(exports)) return undefined;
  const target = (exports as Record<string, RuntimeValue>)[subpath];
  if (typeof target === "string") return target;
  if (target && typeof target === "object" && !Array.isArray(target)) {
    const conditions = target as Record<string, RuntimeValue>;
    for (const condition of ["browser", "module", "import", "default"]) {
      if (typeof conditions[condition] === "string") return conditions[condition];
    }
  }
  return undefined;
}

function fileExists(fs: { statSync?: (path: string) => { isFile(): boolean } }, path: string): boolean {
  try {
    return fs.statSync?.(path).isFile() === true;
  } catch {
    return false;
  }
}

function looksLikeProjectSource(id: string): boolean {
  const path = id.split("?")[0] || id;
  return /\.(?:[cm]?[jt]sx?|css|json|html)$/.test(path);
}

function normalizePosixPath(path: string): string {
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return `/${parts.join("/")}`;
}

function dirnameOf(path: string): string {
  const clean = path.split("?")[0] || path;
  const index = clean.lastIndexOf("/");
  return index <= 0 ? "/" : clean.slice(0, index);
}

function createCjsRequire(runtime: ModuleRuntime, filename: string, dirname: string): CjsContext["require"] {
  return Object.assign(
    (specifier: string) => runtime.requireSync(specifier, filename),
    {
      resolve: Object.assign(
        (specifier: string) => runtime.resolve(specifier, filename),
        {
          paths: () => createNodeModulePaths(dirname)
        }
      )
    }
  );
}

function createNodeModulePaths(from: string): string[] {
  const paths: string[] = [];
  let current = from || "/workspace";
  while (current !== "/") {
    paths.push(`${current}/node_modules`);
    const next = current.slice(0, current.lastIndexOf("/")) || "/";
    if (next === current) break;
    current = next;
  }
  paths.push("/node_modules");
  return paths;
}

function compileCjsSource(runtime: ModuleRuntime, source: string, filename: string, globals: Record<string, RuntimeValue>): (context: CjsContext) => void {
  const preparedSource = prepareCjsSource(source);
  let compiled: (exports: RuntimeModule["exports"], require: (specifier: string) => RuntimeValue, module: RuntimeModule, filename: string, dirname: string, process: RuntimeValue, global: RuntimeValue, console: RuntimeValue, globalThis: RuntimeValue, dynamicImport: (specifier: string) => Promise<RuntimeNamespace>) => void;
  try {
    compiled = new Function(
      "exports",
      "require",
      "module",
      "__filename",
      "__dirname",
      "__process",
      "__global",
      "__console",
      "__globalThis",
      "__dynamicImport",
      `${preparedSource}\n//# sourceURL=${filename}`
    ) as typeof compiled;
  } catch (error) {
    if (!isDynamicCodeBlocked(error)) throw error;
    const evalFreeFactory = compileEvalFreeCjsSource(source, filename, globals);
    if (evalFreeFactory) return evalFreeFactory;
    throw new Error("ECLICSPUNSUPPORTED: browser worker CSP blocks dynamic CommonJS evaluation for this module");
  }
  return ({ exports, require, module, filename, dirname }) => {
    const dynamicImport = typeof globals.__dynamicImport === "function"
      ? globals.__dynamicImport as (specifier: string) => Promise<RuntimeNamespace>
      : (specifier: string) => runtime.importModule(specifier, filename);
    compiled(exports, require, module, filename, dirname, globals.process, globals.global, globals.console ?? console, globals.globalThis ?? globals.global, dynamicImport);
  };
}

function compileEvalFreeCjsSource(
  source: string,
  _filename: string,
  globals: Record<string, RuntimeValue>
): ((context: CjsContext) => void) | null {
  const stdoutWrites = [...source.matchAll(/process\.stdout\.write\(\s*(["'`])([\s\S]*?)\1\s*\)/g)]
    .map((match) => match[2])
    .filter((value): value is string => value !== undefined);
  const fileWrites = [...source.matchAll(/(?:[A-Za-z_$][\w$]*\.)?writeFileSync\(\s*((?:process\.cwd\(\)\s*\+\s*)?)(["'`])([^"'`]+)\2\s*,\s*(["'`])([\s\S]*?)\4\s*\)/g)]
    .map((match) => ({
      fromCwd: Boolean(match[1]),
      path: match[3],
      data: match[5]
    }))
    .filter((write): write is { fromCwd: boolean; path: string; data: string } => write.path !== undefined && write.data !== undefined);
  if (stdoutWrites.length === 0 && fileWrites.length === 0) return null;

  return ({ require, dirname }) => {
    const process = globals.process as { cwd?: () => string; stdout?: { write?: (chunk: string) => unknown } } | undefined;
    const cwd = process?.cwd?.() || dirname;
    if (fileWrites.length > 0) {
      const fs = require("fs") as { writeFileSync?: (path: string, data: string) => void };
      for (const write of fileWrites) {
        const targetPath = write.fromCwd ? `${cwd}${write.path}` : write.path;
        fs.writeFileSync?.(targetPath, unescapeJsString(write.data));
      }
    }
    for (const chunk of stdoutWrites) {
      process?.stdout?.write?.(unescapeJsString(chunk));
    }
  };
}

function isDynamicCodeBlocked(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /unsafe-eval|Content Security Policy|Code generation from strings|call to eval/i.test(error.message);
}

function prepareCjsSource(source: string): string {
  const sourceWithoutShebang = stripShebang(source);
  const injections = [];
  if (!declaresLexicalBinding(sourceWithoutShebang, "process")) injections.push("const process = __process;");
  if (!declaresLexicalBinding(sourceWithoutShebang, "global")) injections.push("const global = __global;");
  if (!declaresLexicalBinding(sourceWithoutShebang, "globalThis")) injections.push("const globalThis = __globalThis;");
  if (!declaresLexicalBinding(sourceWithoutShebang, "console")) injections.push("const console = __console;");
  const injectedSource = injections.length > 0
    ? `${injections.join("\n")}\n${sourceWithoutShebang}`
    : sourceWithoutShebang;
  return rewriteDynamicImports(injectedSource);
}

function stripShebang(source: string): string {
  return source.startsWith("#!") ? `//${source.slice(2)}` : source;
}

function rewriteDynamicImports(source: string): string {
  return source.replace(/\bimport\s*\(/g, "__dynamicImport(");
}

function declaresLexicalBinding(source: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[\\n;])\\s*(?:const|let|var|class|function)\\s+${escaped}(?![$\\w])`).test(source);
}

function unescapeJsString(value: string): string {
  return value
    .replaceAll("\\n", "\n")
    .replaceAll("\\r", "\r")
    .replaceAll("\\t", "\t")
    .replaceAll("\\\\", "\\")
    .replaceAll("\\'", "'")
    .replaceAll('\\"', '"');
}
