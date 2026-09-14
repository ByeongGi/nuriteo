import type { ModuleRuntime } from "./runtime.ts";
import type { CjsContext, RuntimeModule, RuntimeValue } from "../types.ts";

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
    : compileCjsSource(definition.source, canonicalUrl);
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

function compileCjsSource(source: string, filename: string): (context: CjsContext) => void {
  const compiled = new Function(
    "exports",
    "require",
    "module",
    "__filename",
    "__dirname",
    `${source}\n//# sourceURL=${filename}`
  ) as (exports: RuntimeModule["exports"], require: (specifier: string) => RuntimeValue, module: RuntimeModule, filename: string, dirname: string) => void;
  return ({ exports, require, module, filename, dirname }) => {
    compiled(exports, require, module, filename, dirname);
  };
}
