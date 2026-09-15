import type { EsmRecord } from "./cache.ts";
import type { ModuleRuntime } from "./runtime.ts";
import type { EsmContext, RuntimeNamespace, RuntimeValue } from "../types.ts";

export async function evaluateEsm(runtime: ModuleRuntime, url: string): Promise<RuntimeNamespace> {
  const canonicalUrl = runtime.cache.canonicalize(url);
  const existing = runtime.cache.esm.get(canonicalUrl);
  if (existing?.status === "evaluated") return existing.namespace;
  if (existing?.status === "evaluating") return existing.namespace;

  const definition = runtime.getDefinition(canonicalUrl);
  if (!definition) throw new Error(`ERR_MODULE_NOT_FOUND: ${canonicalUrl}`);
  if (definition.kind !== "esm" && definition.kind !== "esm-source") {
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

  if (definition.kind === "esm") {
    for (const specifier of definition.imports || []) {
      await runtime.importModule(specifier, canonicalUrl);
    }
  }

  const context = {
    url: canonicalUrl,
    importMeta: Object.freeze({
      url: `file://${canonicalUrl}`,
      dirname: canonicalUrl.slice(0, canonicalUrl.lastIndexOf("/")) || "/",
      filename: canonicalUrl,
      resolve: (specifier: string) => runtime.resolveImport(specifier, canonicalUrl)
    }),
    importNamespace: (specifier: string) => runtime.importSync(specifier, canonicalUrl),
    dynamicImport: (specifier: string) => runtime.importModule(specifier, canonicalUrl),
    exportConst: (name: string, value: RuntimeValue) => defineBinding(namespace, bindings, name, () => value),
    exportLive: (name: string, getter: () => RuntimeValue) => defineBinding(namespace, bindings, name, getter)
  };

  if (definition.kind === "esm-source") {
    await compileEsmSource(definition.source, canonicalUrl, runtime.globals)(context);
  } else {
    await definition.factory(context);
  }
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

function compileEsmSource(source: string, filename: string, globals: Record<string, RuntimeValue>): (context: EsmContext) => Promise<void> {
  return createEsmSourceCompiler(prepareEsmSource(source), filename, globals);
}

function createEsmSourceCompiler(source: string, filename: string, globals: Record<string, RuntimeValue>): (context: EsmContext) => Promise<void> {
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (...args: string[]) => (context: {
    dynamicImport: (specifier: string) => Promise<RuntimeNamespace>;
    exportConst: (name: string, value: RuntimeValue) => void;
  }, process: RuntimeValue, global: RuntimeValue, console: RuntimeValue) => Promise<void>;
  const compiled = new AsyncFunction(
    "__context",
    "process",
    "global",
    "console",
    `const __import = __context.dynamicImport;\nconst __exportConst = __context.exportConst;\n${source}\n//# sourceURL=${filename}`
  );
  return (context) => compiled(context, globals.process, globals.global, globals.console ?? console);
}

function prepareEsmSource(source: string): string {
  const declarationExports = collectDeclarationExports(source);
  const prepared = source
    .replace(/^#!.*(?:\n|$)/, "")
    .replace(/^[ \t]*import\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s+["']([^"']+)["'];?[ \t]*$/gm, "const $1 = await __import(\"$2\");")
    .replace(/^[ \t]*import\s+([A-Za-z_$][\w$]*)\s*,\s*\{([^}\n]+)\}\s+from\s+["']([^"']+)["'];?[ \t]*$/gm, (_match, defaultName: string, named: string, specifier: string) => {
      return rewriteDefaultAndNamedImport(defaultName, named, specifier);
    })
    .replace(/^[ \t]*import\s+\{([^}\n]+)\}\s+from\s+["']([^"']+)["'];?[ \t]*$/gm, (_match, named: string, specifier: string) => {
      return `const { ${rewriteNamedImportBindings(named)} } = await __import("${specifier}");`;
    })
    .replace(/^[ \t]*import\s+([A-Za-z_$][\w$]*)\s+from\s+["']([^"']+)["'];?[ \t]*$/gm, "const $1 = (await __import(\"$2\")).default;")
    .replace(/^[ \t]*import\s+["']([^"']+)["'];?[ \t]*$/gm, "await __import(\"$1\");")
    .replace(/\bimport\s*\(/g, "__import(")
    .replace(/^[ \t]*export\s+const\s+([A-Za-z_$][\w$]*)\s*=\s*([^;\n]+);?[ \t]*$/gm, "const $1 = $2;\n__exportConst(\"$1\", $1);")
    .replace(/^[ \t]*export\s+async\s+function\s+([A-Za-z_$][\w$]*)\s*\(/gm, "async function $1(")
    .replace(/^[ \t]*export\s+function\s+([A-Za-z_$][\w$]*)\s*\(/gm, "function $1(")
    .replace(/^[ \t]*export\s+class\s+([A-Za-z_$][\w$]*)\b/gm, "class $1")
    .replace(/^[ \t]*export\s+default\s+([^;\n]+);?[ \t]*$/gm, "__exportConst(\"default\", $1);")
    .replace(/^[ \t]*export\s+\*\s+from\s+["']([^"']+)["'];?[ \t]*$/gm, (_match, specifier: string) => {
      return rewriteStarReExport(specifier);
    })
    .replace(/^[ \t]*export\s+\{([^}]+)\}\s+from\s+["']([^"']+)["'];?[ \t]*$/gm, (_match, clause: string, specifier: string) => {
      return rewriteNamedReExport(clause, specifier);
    })
    .replace(/^[ \t]*export\s+\{([^}]+)\};?[ \t]*$/gm, (_match, clause: string) => {
      return rewriteNamedExport(clause);
    })
    .replace(/\bimport\.meta\b/g, "__context.importMeta");
  return declarationExports.length > 0
    ? `${prepared}\n${declarationExports.map((name) => `__exportConst("${name}", ${name});`).join("\n")}`
    : prepared;
}

function collectDeclarationExports(source: string): string[] {
  const names = new Set<string>();
  const pattern = /^[ \t]*export\s+(?:async\s+)?(?:function|class)\s+([A-Za-z_$][\w$]*)\b/gm;
  for (const match of source.matchAll(pattern)) {
    if (match[1]) names.add(match[1]);
  }
  return [...names];
}

function rewriteDefaultAndNamedImport(defaultName: string, named: string, specifier: string): string {
  const temp = `__esm_${defaultName}`;
  return [
    `const ${temp} = await __import("${specifier}");`,
    `const ${defaultName} = ${temp}.default;`,
    `const { ${rewriteNamedImportBindings(named)} } = ${temp};`
  ].join("\n");
}

function rewriteNamedImportBindings(clause: string): string {
  return clause
    .split(",")
    .map((binding) => binding.trim())
    .filter(Boolean)
    .map((binding) => binding.replace(/\s+as\s+/g, ": "))
    .join(", ");
}

function rewriteNamedExport(clause: string): string {
  return clause
    .split(",")
    .map((binding) => binding.trim())
    .filter(Boolean)
    .map((binding) => {
      const [local, exported] = binding.split(/\s+as\s+/);
      const localName = local?.trim();
      if (!localName) return "";
      return `__exportConst("${(exported || localName).trim()}", ${localName});`;
    })
    .filter(Boolean)
    .join("\n");
}

function rewriteNamedReExport(clause: string, specifier: string): string {
  const temp = `__reexport_${Math.abs(hashString(`${specifier}:${clause}`))}`;
  return [
    `const ${temp} = await __import("${specifier}");`,
    ...clause
      .split(",")
      .map((binding) => binding.trim())
      .filter(Boolean)
      .map((binding) => {
        const [imported, exported] = binding.split(/\s+as\s+/);
        const importedName = imported?.trim();
        if (!importedName) return "";
        return `__exportConst("${(exported || importedName).trim()}", ${temp}.${importedName});`;
      })
      .filter(Boolean)
  ].join("\n");
}

function rewriteStarReExport(specifier: string): string {
  const temp = `__reexport_all_${Math.abs(hashString(specifier))}`;
  return [
    `const ${temp} = await __import("${specifier}");`,
    `for (const __key of Object.keys(${temp})) {`,
    `  if (__key !== "default") __exportConst(__key, ${temp}[__key]);`,
    "}"
  ].join("\n");
}

function hashString(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) | 0;
  }
  return hash;
}
