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
    return this.resolveWithConditions(specifier, parentUrl, ["require", "node", "default", "import"]);
  }

  resolveImport(specifier: string, parentUrl = "/workspace/index.mjs"): string {
    return this.resolveWithConditions(specifier, parentUrl, ["import", "node", "default", "require"]);
  }

  resolveWithConditions(specifier: string, parentUrl: string, conditions: readonly string[]): string {
    if (specifier.startsWith("#")) {
      return this.resolveImports(specifier, parentUrl, conditions);
    }
    if (specifier === "." || specifier === ".." || specifier.startsWith("/") || specifier.startsWith("./") || specifier.startsWith("../")) {
      const base = specifier.startsWith("/") ? specifier : `${dirname(parentUrl)}/${specifier}`;
      return this.resolvePath(base);
    }
    return this.resolvePackage(specifier, parentUrl, conditions);
  }

  resolveImports(specifier: string, parentUrl: string, conditions: readonly string[] = ["require", "node", "default", "import"]): string {
    const target = this.imports[specifier];
    if (!target) throw new Error(`ERR_PACKAGE_IMPORT_NOT_DEFINED: ${specifier} from ${parentUrl}`);
    return this.resolveWithConditions(target, parentUrl, conditions);
  }

  resolvePackage(specifier: string, parentUrl = "/workspace/index.mjs", conditions: readonly string[] = ["require", "node", "default", "import"]): string {
    const name = packageName(specifier);
    const root = this.findPackageRoot(name, parentUrl) || this.findSelfPackageRoot(name, parentUrl);
    const manifest = root ? this.packageRoots[root] : this.packages[name];
    if (!manifest) throw moduleNotFound(`ERR_MODULE_NOT_FOUND: ${specifier}`);

    const subpath = specifier === name ? "." : `.${specifier.slice(name.length)}`;
    const target = resolvePackageTarget(manifest, subpath, conditions);
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
    throw moduleNotFound(`ERR_MODULE_NOT_FOUND: ${path}`);
  }
}

function moduleNotFound(message: string): Error & { code: "MODULE_NOT_FOUND" } {
  return Object.assign(new Error(message), { code: "MODULE_NOT_FOUND" as const });
}

function resolvePackageTarget(manifest: PackageManifest, subpath: string, conditions: readonly string[]): string | undefined {
  if (manifest.exports) {
    if (typeof manifest.exports === "string" || Array.isArray(manifest.exports)) {
      return subpath === "." ? resolveConditionalTarget(manifest.exports, conditions) : undefined;
    }
    const target = isConditionalExportMap(manifest.exports)
      ? subpath === "." ? manifest.exports : undefined
      : resolveSubpathExport(manifest.exports, subpath);
    return target ? resolveConditionalTarget(target, conditions) : undefined;
  }
  if (subpath === ".") return manifest.main || "./index.js";
  return subpath;
}

function resolveSubpathExport(exportsMap: Record<string, PackageExportTarget | undefined>, subpath: string): PackageExportTarget | undefined {
  const exact = exportsMap[subpath];
  if (exact) return exact;
  for (const [pattern, target] of Object.entries(exportsMap)) {
    if (!target) continue;
    const star = pattern.indexOf("*");
    if (star < 0) continue;
    const prefix = pattern.slice(0, star);
    const suffix = pattern.slice(star + 1);
    if (!subpath.startsWith(prefix) || !subpath.endsWith(suffix)) continue;
    const matched = subpath.slice(prefix.length, subpath.length - suffix.length);
    return replaceExportPatternTarget(target, matched);
  }
  return undefined;
}

function replaceExportPatternTarget(target: PackageExportTarget, matched: string): PackageExportTarget {
  if (typeof target === "string") return target.replaceAll("*", matched);
  if (Array.isArray(target)) return target.map((item) => replaceExportPatternTarget(item, matched));
  const replaced: Record<string, PackageExportTarget> = {};
  for (const [condition, value] of Object.entries(target)) {
    if (value !== undefined) replaced[condition] = replaceExportPatternTarget(value, matched);
  }
  return replaced;
}

function resolveConditionalTarget(target: PackageExportTarget, conditions: readonly string[]): string | undefined {
  if (typeof target === "string") return target;
  if (Array.isArray(target)) {
    for (const item of target) {
      const resolved = resolveConditionalTarget(item, conditions);
      if (resolved) return resolved;
    }
    return undefined;
  }
  for (const condition of conditions) {
    const resolved = target[condition] ? resolveConditionalTarget(target[condition], conditions) : undefined;
    if (resolved) return resolved;
  }
  return undefined;
}

function isConditionalExportMap(exportsMap: Record<string, PackageExportTarget | undefined>): boolean {
  return Object.keys(exportsMap).some((key) => !key.startsWith("."));
}
