import type { ModuleRuntime } from "./runtime.ts";
import type { RuntimeModule, RuntimeValue } from "../types.ts";

export function evaluateCjs(runtime: ModuleRuntime, url: string): RuntimeValue {
  const canonicalUrl = runtime.cache.canonicalize(url);
  const cached = runtime.cache.cjs.get(canonicalUrl);
  if (cached) return cached.exports;

  const definition = runtime.getDefinition(canonicalUrl);
  if (!definition || definition.kind !== "cjs") {
    throw new Error(`ERR_REQUIRE_ESM_OR_MISSING: ${canonicalUrl}`);
  }

  const module: RuntimeModule = {
    id: canonicalUrl,
    exports: {},
    loaded: false
  };
  runtime.cache.cjs.set(canonicalUrl, module);

  const require = (specifier: string) => runtime.requireSync(specifier, canonicalUrl);
  definition.factory({
    exports: module.exports,
    module,
    require,
    filename: canonicalUrl,
    dirname: canonicalUrl.slice(0, canonicalUrl.lastIndexOf("/")) || "/"
  });
  module.loaded = true;
  return module.exports;
}
