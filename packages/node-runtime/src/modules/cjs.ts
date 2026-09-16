import type { ModuleRuntime } from "./runtime.ts";
import { evaluateEsmSync } from "./esm.ts";
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
      return createPendingEsmNamespaceProxy(record?.namespace || {});
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

function createPendingEsmNamespaceProxy(namespace: RuntimeNamespace): RuntimeNamespace {
  const knownProperties = new Set<PropertyKey>(Reflect.ownKeys(namespace));
  const placeholder = function AsyncEsmBindingPlaceholder() {};
  Object.defineProperty(placeholder.prototype, "getOrder", {
    configurable: true,
    value: () => undefined
  });
  return new Proxy(namespace, {
    defineProperty(target, property, descriptor) {
      knownProperties.add(property);
      return Reflect.defineProperty(target, property, descriptor);
    },
    get(target, property, receiver) {
      if (property === "__esModule") return true;
      const value = Reflect.get(target, property, receiver);
      if (value !== undefined) return value;
      return typeof property === "string" ? placeholder : value;
    },
    getOwnPropertyDescriptor(target, property) {
      knownProperties.add(property);
      return Reflect.getOwnPropertyDescriptor(target, property) || {
        configurable: true,
        enumerable: true,
        get: () => Reflect.get(target, property) ?? placeholder
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
