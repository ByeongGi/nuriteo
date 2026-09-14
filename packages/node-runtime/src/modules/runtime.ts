import { ModuleCache } from "./cache.ts";
import { evaluateCjs } from "./cjs.ts";
import { evaluateEsm } from "./esm.ts";
import { ModuleResolver } from "./resolver.ts";

export class ModuleRuntime {
  constructor(options = {}) {
    this.definitions = new Map();
    this.cache = new ModuleCache({ realpaths: options.realpaths });
    this.resolver = new ModuleResolver({
      modules: this.definitions,
      packages: options.packages,
      imports: options.imports,
      realpath: (url) => this.cache.canonicalize(url)
    });
  }

  register(url, definition) {
    this.definitions.set(this.cache.canonicalize(url), definition);
    return this;
  }

  registerMany(definitions) {
    for (const [url, definition] of Object.entries(definitions)) {
      this.register(url, definition);
    }
    return this;
  }

  getDefinition(url) {
    return this.definitions.get(this.cache.canonicalize(url));
  }

  resolve(specifier, parentUrl) {
    return this.resolver.resolve(specifier, parentUrl);
  }

  requireSync(specifier, parentUrl = "/workspace/index.cjs") {
    const url = this.resolve(specifier, parentUrl);
    return evaluateCjs(this, url);
  }

  importSync(specifier, parentUrl = "/workspace/index.mjs") {
    const url = this.resolve(specifier, parentUrl);
    const existing = this.cache.esm.get(url);
    if (existing) return existing.namespace;

    const definition = this.getDefinition(url);
    if (definition?.kind === "cjs") {
      return evaluateCjs(this, url);
    }

    const namespace = {};
    this.cache.esm.set(url, {
      status: "evaluating",
      namespace,
      bindings: new Map()
    });
    return namespace;
  }

  async importModule(specifier, parentUrl = "/workspace/index.mjs") {
    const url = this.resolve(specifier, parentUrl);
    return evaluateEsm(this, url);
  }
}

export function createModuleRuntime(options) {
  return new ModuleRuntime(options);
}
