import type { ModuleRuntime } from "./runtime.ts";
import type { CjsContext, RuntimeModule, RuntimeNamespace, RuntimeValue } from "../types.ts";

export function evaluateCjs(runtime: ModuleRuntime, url: string): RuntimeValue {
  const canonicalUrl = runtime.cache.canonicalize(url);
  const cached = runtime.cache.cjs.get(canonicalUrl);
  if (cached) return cached.exports;

  const definition = runtime.getDefinition(canonicalUrl);
  if (!definition || definition.kind === "esm") {
    throw new Error(`ERR_REQUIRE_ESM_OR_MISSING: ${canonicalUrl}`);
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

  const require = (specifier: string) => runtime.requireSync(specifier, canonicalUrl);
  const factory = definition.kind === "cjs"
    ? definition.factory
    : compileCjsSource(runtime, definition.source, canonicalUrl, runtime.globals);
  factory({
    exports: module.exports,
    module,
    require,
    filename: canonicalUrl,
    dirname: canonicalUrl.slice(0, canonicalUrl.lastIndexOf("/")) || "/"
  });
  module.loaded = true;
  return module.exports;
}

function compileCjsSource(runtime: ModuleRuntime, source: string, filename: string, globals: Record<string, RuntimeValue>): (context: CjsContext) => void {
  const compiled = new Function(
    "exports",
    "require",
    "module",
    "__filename",
    "__dirname",
    "process",
    "global",
    "__dynamicImport",
    `${rewriteDynamicImports(stripShebang(source))}\n//# sourceURL=${filename}`
  ) as (exports: RuntimeModule["exports"], require: (specifier: string) => RuntimeValue, module: RuntimeModule, filename: string, dirname: string, process: RuntimeValue, global: RuntimeValue, dynamicImport: (specifier: string) => Promise<RuntimeNamespace>) => void;
  return ({ exports, require, module, filename, dirname }) => {
    const dynamicImport = typeof globals.__dynamicImport === "function"
      ? globals.__dynamicImport as (specifier: string) => Promise<RuntimeNamespace>
      : (specifier: string) => runtime.importModule(specifier, filename);
    compiled(exports, require, module, filename, dirname, globals.process, globals.global, dynamicImport);
  };
}

function stripShebang(source: string): string {
  return source.startsWith("#!") ? `//${source.slice(2)}` : source;
}

function rewriteDynamicImports(source: string): string {
  return source.replace(/\bimport\s*\(/g, "__dynamicImport(");
}
