import type { ModuleRuntimeOptions, PackageExportTarget, PackageManifest } from "../types.ts";

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
  packageRoots: Record<string, PackageManifest>;
  imports: Record<string, string>;
  realpath: (url: string) => string;

  constructor(options: ModuleRuntimeOptions & { modules?: Map<string, unknown>; realpath?: (url: string) => string } = {}) {
    this.modules = options.modules || new Map();
    this.packages = options.packages || {};
    this.packageRoots = options.packageRoots || {};
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
    return this.resolvePackage(specifier, parentUrl);
  }

  resolveImports(specifier: string, parentUrl: string): string {
    const target = this.imports[specifier];
    if (!target) throw new Error(`ERR_PACKAGE_IMPORT_NOT_DEFINED: ${specifier} from ${parentUrl}`);
    return this.resolve(target, parentUrl);
  }

  resolvePackage(specifier: string, parentUrl = "/workspace/index.mjs"): string {
    const name = packageName(specifier);
    const root = this.findPackageRoot(name, parentUrl) || this.findSelfPackageRoot(name, parentUrl);
    const manifest = root ? this.packageRoots[root] : this.packages[name];
    if (!manifest) throw new Error(`ERR_MODULE_NOT_FOUND: ${specifier}`);

    const subpath = specifier === name ? "." : `.${specifier.slice(name.length)}`;
    const target = resolvePackageTarget(manifest, subpath);
    if (!target) throw new Error(`ERR_PACKAGE_PATH_NOT_EXPORTED: ${specifier}`);

    const packageRoot = root || manifest.root || `/workspace/node_modules/${name}`;
    return this.resolvePath(`${packageRoot}/${target}`);
  }

  findPackageRoot(name: string, parentUrl: string): string | null {
    let current = dirname(parentUrl);
    while (true) {
      const candidate = normalizePath(`${current}/node_modules/${name}`);
      const real = this.realpath(candidate);
      if (this.packageRoots[real] || this.packageRoots[candidate]) return this.packageRoots[real] ? real : candidate;
      if (current === "/") return null;
      current = dirname(current);
    }
  }

  findSelfPackageRoot(name: string, parentUrl: string): string | null {
    let bestRoot: string | null = null;
    for (const [root, manifest] of Object.entries(this.packageRoots)) {
      if (manifest.name !== name) continue;
      const prefix = root.endsWith("/") ? root : `${root}/`;
      if ((parentUrl === root || parentUrl.startsWith(prefix)) && (!bestRoot || root.length > bestRoot.length)) {
        bestRoot = root;
      }
    }
    return bestRoot;
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
    if (typeof manifest.exports === "string" || Array.isArray(manifest.exports)) {
      return subpath === "." ? resolveConditionalTarget(manifest.exports) : undefined;
    }
    const target = isConditionalExportMap(manifest.exports)
      ? subpath === "." ? manifest.exports : undefined
      : manifest.exports[subpath];
    return target ? resolveConditionalTarget(target) : undefined;
  }
  if (subpath === ".") return manifest.main || "./index.js";
  return subpath;
}

function resolveConditionalTarget(target: PackageExportTarget): string | undefined {
  if (typeof target === "string") return target;
  if (Array.isArray(target)) {
    for (const item of target) {
      const resolved = resolveConditionalTarget(item);
      if (resolved) return resolved;
    }
    return undefined;
  }
  for (const condition of ["require", "node", "default", "import"]) {
    const resolved = target[condition] ? resolveConditionalTarget(target[condition]) : undefined;
    if (resolved) return resolved;
  }
  return undefined;
}

function isConditionalExportMap(exportsMap: Record<string, PackageExportTarget | undefined>): boolean {
  return Object.keys(exportsMap).some((key) => !key.startsWith("."));
}
