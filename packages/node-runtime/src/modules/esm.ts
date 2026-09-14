import type { EsmRecord } from "./cache.ts";
import type { ModuleRuntime } from "./runtime.ts";
import type { RuntimeNamespace, RuntimeValue } from "../types.ts";

export async function evaluateEsm(runtime: ModuleRuntime, url: string): Promise<RuntimeNamespace> {
  const canonicalUrl = runtime.cache.canonicalize(url);
  const existing = runtime.cache.esm.get(canonicalUrl);
  if (existing?.status === "evaluated") return existing.namespace;
  if (existing?.status === "evaluating") return existing.namespace;

  const definition = runtime.getDefinition(canonicalUrl);
  if (!definition) throw new Error(`ERR_MODULE_NOT_FOUND: ${canonicalUrl}`);
  if (definition.kind === "cjs") {
    return cjsNamespace(runtime.requireSync(canonicalUrl, canonicalUrl));
  }

  const bindings = new Map<string, () => RuntimeValue>();
  const namespace: RuntimeNamespace = {};
  const record: EsmRecord = {
    status: "evaluating",
    namespace,
    bindings
  };
  runtime.cache.esm.set(canonicalUrl, record);

  for (const specifier of definition.imports || []) {
    await runtime.importModule(specifier, canonicalUrl);
  }

  const context = {
    url: canonicalUrl,
    importMeta: Object.freeze({
      url: `file://${canonicalUrl}`,
      dirname: canonicalUrl.slice(0, canonicalUrl.lastIndexOf("/")) || "/",
      filename: canonicalUrl,
      resolve: (specifier: string) => runtime.resolve(specifier, canonicalUrl)
    }),
    importNamespace: (specifier: string) => runtime.importSync(specifier, canonicalUrl),
    dynamicImport: (specifier: string) => runtime.importModule(specifier, canonicalUrl),
    exportConst: (name: string, value: RuntimeValue) => defineBinding(namespace, bindings, name, () => value),
    exportLive: (name: string, getter: () => RuntimeValue) => defineBinding(namespace, bindings, name, getter)
  };

  await definition.factory(context);
  record.status = "evaluated";
  return namespace;
}

function defineBinding(namespace: RuntimeNamespace, bindings: Map<string, () => RuntimeValue>, name: string, getter: () => RuntimeValue): void {
  bindings.set(name, getter);
  if (!Object.prototype.hasOwnProperty.call(namespace, name)) {
    Object.defineProperty(namespace, name, {
      enumerable: true,
      get: () => bindings.get(name)?.()
    });
  }
}

export function cjsNamespace(exports: RuntimeValue): RuntimeNamespace {
  const namespace: RuntimeNamespace = {};
  Object.defineProperty(namespace, "default", {
    enumerable: true,
    value: exports
  });
  if ((typeof exports === "object" || typeof exports === "function") && exports) {
    for (const key of Object.keys(exports)) {
      Object.defineProperty(namespace, key, {
        enumerable: true,
        value: (exports as Record<string, unknown>)[key]
      });
    }
  }
  return namespace;
}
