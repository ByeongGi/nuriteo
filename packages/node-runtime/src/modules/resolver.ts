function normalizePath(path) {
  const parts = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return `/${parts.join("/")}`;
}

function dirname(path) {
  const index = path.lastIndexOf("/");
  return index <= 0 ? "/" : path.slice(0, index);
}

function packageName(specifier) {
  if (specifier.startsWith("@")) {
    const [scope, name] = specifier.split("/");
    return `${scope}/${name}`;
  }
  return specifier.split("/")[0];
}

export class ModuleResolver {
  constructor(options = {}) {
    this.modules = options.modules || new Map();
    this.packages = options.packages || {};
    this.imports = options.imports || {};
    this.realpath = options.realpath || ((url) => url);
  }

  resolve(specifier, parentUrl = "/workspace/index.mjs") {
    if (specifier.startsWith("#")) {
      return this.resolveImports(specifier, parentUrl);
    }
    if (specifier.startsWith("/") || specifier.startsWith("./") || specifier.startsWith("../")) {
      const base = specifier.startsWith("/") ? specifier : `${dirname(parentUrl)}/${specifier}`;
      return this.resolvePath(base);
    }
    return this.resolvePackage(specifier);
  }

  resolveImports(specifier, parentUrl) {
    const target = this.imports[specifier];
    if (!target) throw new Error(`ERR_PACKAGE_IMPORT_NOT_DEFINED: ${specifier} from ${parentUrl}`);
    return this.resolve(target, parentUrl);
  }

  resolvePackage(specifier) {
    const name = packageName(specifier);
    const manifest = this.packages[name];
    if (!manifest) throw new Error(`ERR_MODULE_NOT_FOUND: ${specifier}`);

    const subpath = specifier === name ? "." : `.${specifier.slice(name.length)}`;
    const exportsMap = manifest.exports || {};
    const target = typeof exportsMap === "string" && subpath === "."
      ? exportsMap
      : exportsMap[subpath];
    if (!target) throw new Error(`ERR_PACKAGE_PATH_NOT_EXPORTED: ${specifier}`);

    const packageRoot = manifest.root || `/workspace/node_modules/${name}`;
    return this.resolvePath(`${packageRoot}/${target}`);
  }

  resolvePath(path) {
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
