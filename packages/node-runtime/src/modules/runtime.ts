import { ModuleCache } from "./cache.ts";
import { evaluateCjs } from "./cjs.ts";
import { evaluateEsm, evaluateEsmSync } from "./esm.ts";
import { ModuleResolver } from "./resolver.ts";
import type { ModuleDefinition, ModuleDefinitionMap, ModuleRuntimeOptions, RuntimeNamespace, RuntimeValue } from "../types.ts";
import { builtinModules } from "../builtins/module.ts";

export class ModuleRuntime {
  definitions: Map<string, ModuleDefinition>;
  cache: ModuleCache;
  resolver: ModuleResolver;
  builtins: ModuleRuntimeOptions["builtins"] | undefined;
  globals: Record<string, RuntimeValue>;
  allowAsyncRequireEsm: boolean;
  loadModuleDefinition: ModuleRuntimeOptions["loadModuleDefinition"] | undefined;
  readonly loadedDefinitions = new Set<string>();

  constructor(options: ModuleRuntimeOptions = {}) {
    this.definitions = new Map();
    this.cache = new ModuleCache(options.realpaths ? { realpaths: options.realpaths } : {});
    this.loadModuleDefinition = options.loadModuleDefinition;
    const resolverOptions: ConstructorParameters<typeof ModuleResolver>[0] = {
      modules: this.definitions,
      moduleExists: (url) => options.moduleExists?.(url) === true || Boolean(this.getDefinition(url)),
      realpath: (url) => this.cache.canonicalize(url)
    };
    if (options.packages) resolverOptions.packages = options.packages;
    if (options.packageRoots) resolverOptions.packageRoots = options.packageRoots;
    if (options.imports) resolverOptions.imports = options.imports;
    this.resolver = new ModuleResolver(resolverOptions);
    this.builtins = options.builtins;
    this.globals = { ...(options.globals || {}) };
    this.allowAsyncRequireEsm = options.allowAsyncRequireEsm === true;
  }

  register(url: string, definition: ModuleDefinition): ModuleRuntime {
    this.definitions.set(this.cache.canonicalize(url), definition);
    return this;
  }

  registerMany(definitions: ModuleDefinitionMap): ModuleRuntime {
    for (const [url, definition] of Object.entries(definitions)) {
      this.register(url, definition);
    }
    return this;
  }

  getDefinition(url: string): ModuleDefinition | undefined {
    const canonicalUrl = this.cache.canonicalize(url);
    const existing = this.definitions.get(canonicalUrl);
    if (existing) return existing;
    const loaded = this.loadModuleDefinition?.(canonicalUrl);
    if (!loaded) return undefined;
    this.register(canonicalUrl, loaded);
    this.loadedDefinitions.add(canonicalUrl);
    return loaded;
  }

  invalidateLoadedDefinition(url: string): void {
    const canonicalUrl = this.cache.canonicalize(url);
    if (!this.loadedDefinitions.delete(canonicalUrl)) return;
    this.definitions.delete(canonicalUrl);
  }

  resolve(specifier: string, parentUrl?: string): string {
    return this.resolver.resolve(specifier, parentUrl);
  }

  resolveImport(specifier: string, parentUrl?: string): string {
    return this.resolver.resolveImport(specifier, parentUrl);
  }

  requireSync(specifier: string, parentUrl = "/workspace/index.cjs"): RuntimeValue {
    if (this.builtins && builtinModules.includes(specifier)) return this.builtins(specifier);
    const url = this.resolve(specifier, parentUrl);
    return evaluateCjs(this, url);
  }

  importSync(specifier: string, parentUrl = "/workspace/index.mjs"): RuntimeNamespace {
    if (this.builtins && builtinModules.includes(specifier)) return asEsmNamespace(this.builtins(specifier));
    const url = this.resolveImport(specifier, parentUrl);
    const existing = this.cache.esm.get(url);
    if (existing) return existing.namespace;

    const definition = this.getDefinition(url);
    if (definition?.kind === "cjs") {
      return evaluateCjs(this, url) as RuntimeNamespace;
    }
    return evaluateEsmSync(this, url);
  }

  async importModule(specifier: string, parentUrl = "/workspace/index.mjs"): Promise<RuntimeNamespace> {
    if (this.builtins && builtinModules.includes(specifier)) return asEsmNamespace(this.builtins(specifier));
    const url = this.resolveImport(specifier, parentUrl);
    return evaluateEsm(this, url);
  }
}

export function createModuleRuntime(options: ModuleRuntimeOptions = {}): ModuleRuntime {
  return new ModuleRuntime(options);
}

function asEsmNamespace(value: RuntimeValue): RuntimeNamespace {
  const namespace: RuntimeNamespace = { default: value };
  if ((typeof value === "object" || typeof value === "function") && value) {
    for (const key of Object.keys(value)) {
      namespace[key] = (value as Record<string, RuntimeValue>)[key];
    }
  }
  return namespace;
}
