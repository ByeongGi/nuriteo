import type { ModuleRuntimeOptions, PackageManifest } from "../types.ts";

function normalizePath(path: string): string {
  const parts = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return `/${parts.join("/")}`;
}

function dirname(path: string): string {
  const index = path.lastIndexOf("/");
  return index <= 0 ? "/" : path.slice(0, index);
}

function packageName(specifier: string): string {
  if (specifier.startsWith("@")) {
    const [scope, name] = specifier.split("/");
    return `${scope}/${name}`;
  }
  return specifier.split("/")[0] || specifier;
}

export class ModuleResolver {
  modules: Map<string, unknown>;
  packages: Record<string, PackageManifest>;
  imports: Record<string, string>;
  realpath: (url: string) => string;

  constructor(options: ModuleRuntimeOptions & { modules?: Map<string, unknown>; realpath?: (url: string) => string } = {}) {
    this.modules = options.modules || new Map();
    this.packages = options.packages || {};
    this.imports = options.imports || {};
    this.realpath = options.realpath || ((url) => url);
  }

  resolve(specifier: string, parentUrl = "/workspace/index.mjs"): string {
    if (specifier.startsWith("#")) {
      return this.resolveImports(specifier, parentUrl);
    }
    if (specifier.startsWith("/") || specifier.startsWith("./") || specifier.startsWith("../")) {
      const base = specifier.startsWith("/") ? specifier : `${dirname(parentUrl)}/${specifier}`;
      return this.resolvePath(base);
    }
    return this.resolvePackage(specifier);
  }

  resolveImports(specifier: string, parentUrl: string): string {
    const target = this.imports[specifier];
    if (!target) throw new Error(`ERR_PACKAGE_IMPORT_NOT_DEFINED: ${specifier} from ${parentUrl}`);
    return this.resolve(target, parentUrl);
  }

  resolvePackage(specifier: string): string {
    const name = packageName(specifier);
    const manifest = this.packages[name];
    if (!manifest) throw new Error(`ERR_MODULE_NOT_FOUND: ${specifier}`);

    const subpath = specifier === name ? "." : `.${specifier.slice(name.length)}`;
    const target = resolvePackageTarget(manifest, subpath);
    if (!target) throw new Error(`ERR_PACKAGE_PATH_NOT_EXPORTED: ${specifier}`);

    const packageRoot = manifest.root || `/workspace/node_modules/${name}`;
    return this.resolvePath(`${packageRoot}/${target}`);
  }

  resolvePath(path: string): string {
    const normalized = normalizePath(path);
    const candidates = [
      normalized,
      `${normalized}.mjs`,
      `${normalized}.cjs`,
      `${normalized}.js`,
      `${normalized}/index.mjs`,
      `${normalized}/index.cjs`,
      `${normalized}/index.js`
    ];
    for (const candidate of candidates) {
      const real = this.realpath(candidate);
      if (this.modules.has(real)) return real;
    }
    throw new Error(`ERR_MODULE_NOT_FOUND: ${path}`);
  }
}

function resolvePackageTarget(manifest: PackageManifest, subpath: string): string | undefined {
  if (manifest.exports) {
    return typeof manifest.exports === "string"
      ? subpath === "." ? manifest.exports : undefined
      : manifest.exports[subpath];
  }
  if (subpath === ".") return manifest.main || "./index.js";
  return subpath;
}
