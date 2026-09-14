import { dirname, join, normalize } from "../builtins/path.ts";

export interface CliModuleGraphReader {
  exists(path: string): boolean;
  readText(path: string): string;
}

export interface CliModuleGraphOptions {
  entry: string;
  packageRoot: string;
  reader: CliModuleGraphReader;
  builtins?: Iterable<string>;
  maxModules?: number;
}

export interface CliModuleGraphModule {
  path: string;
  requires: string[];
}

export interface CliModuleGraphIssue {
  specifier: string;
  importer: string;
  kind: "unsupported-builtin" | "missing-module" | "dynamic-require";
}

export interface CliModuleGraph {
  entry: string;
  packageRoot: string;
  modules: CliModuleGraphModule[];
  issues: CliModuleGraphIssue[];
  supported: boolean;
}

const defaultBuiltins = new Set([
  "assert",
  "assert/strict",
  "buffer",
  "events",
  "fs",
  "module",
  "os",
  "path",
  "path/posix",
  "process",
  "stream",
  "stream/promises",
  "tty",
  "url",
  "util",
  "zlib"
]);

export function analyzeCliModuleGraph(options: CliModuleGraphOptions): CliModuleGraph {
  const builtins = new Set(options.builtins || defaultBuiltins);
  const queue = [normalize(options.entry)];
  const seen = new Set<string>();
  const modules: CliModuleGraphModule[] = [];
  const issues: CliModuleGraphIssue[] = [];
  const maxModules = options.maxModules ?? 512;

  while (queue.length > 0 && seen.size < maxModules) {
    const current = queue.shift();
    if (!current || seen.has(current)) continue;
    seen.add(current);
    const source = options.reader.readText(current);
    const requires = extractStaticRequires(source);
    modules.push({ path: current, requires });
    for (const specifier of requires) {
      if (isBuiltin(specifier, builtins)) continue;
      if (specifier.includes("${") || specifier.includes("+")) {
        issues.push({ specifier, importer: current, kind: "dynamic-require" });
        continue;
      }
      const resolved = resolveRequire(specifier, current, options.packageRoot, options.reader);
      if (resolved) queue.push(resolved);
      else issues.push({ specifier, importer: current, kind: "missing-module" });
    }
  }

  return {
    entry: normalize(options.entry),
    packageRoot: normalize(options.packageRoot),
    modules,
    issues,
    supported: issues.length === 0
  };
}

export function extractStaticRequires(source: string): string[] {
  const requires = new Set<string>();
  const pattern = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const match of source.matchAll(pattern)) {
    const specifier = match[1];
    if (specifier) requires.add(specifier);
  }
  return [...requires].sort();
}

function isBuiltin(specifier: string, builtins: Set<string>): boolean {
  const normalized = specifier.startsWith("node:") ? specifier.slice(5) : specifier;
  return builtins.has(normalized);
}

function resolveRequire(specifier: string, importer: string, packageRoot: string, reader: CliModuleGraphReader): string | null {
  if (specifier.startsWith("./") || specifier.startsWith("../") || specifier.startsWith("/")) {
    const base = specifier.startsWith("/") ? specifier : join(dirname(importer), specifier);
    return resolveFileOrDirectory(base, reader);
  }
  return resolvePackage(specifier, importer, packageRoot, reader);
}

function resolvePackage(specifier: string, importer: string, packageRoot: string, reader: CliModuleGraphReader): string | null {
  const [name, subpath] = splitPackageSpecifier(specifier);
  let current = dirname(importer);
  while (current.startsWith(packageRoot)) {
    const root = join(current, "node_modules", name);
    const resolved = subpath ? resolveFileOrDirectory(join(root, subpath), reader) : resolvePackageRoot(root, reader);
    if (resolved) return resolved;
    const next = dirname(current);
    if (next === current) break;
    current = next;
  }
  return resolvePackageRoot(join(packageRoot, "node_modules", name), reader);
}

function resolvePackageRoot(root: string, reader: CliModuleGraphReader): string | null {
  const manifestPath = join(root, "package.json");
  if (reader.exists(manifestPath)) {
    const manifest = JSON.parse(reader.readText(manifestPath)) as { main?: string; exports?: string | Record<string, string> };
    const main = typeof manifest.exports === "string" ? manifest.exports : manifest.main || "index.js";
    const resolved = resolveFileOrDirectory(join(root, main), reader);
    if (resolved) return resolved;
  }
  return resolveFileOrDirectory(join(root, "index"), reader);
}

function resolveFileOrDirectory(base: string, reader: CliModuleGraphReader): string | null {
  const normalized = normalize(base);
  const candidates = [
    normalized,
    `${normalized}.js`,
    `${normalized}.cjs`,
    `${normalized}.mjs`,
    join(normalized, "index.js"),
    join(normalized, "index.cjs"),
    join(normalized, "index.mjs")
  ];
  return candidates.find((candidate) => reader.exists(candidate)) || null;
}

function splitPackageSpecifier(specifier: string): [string, string] {
  const parts = specifier.split("/");
  if (specifier.startsWith("@")) return [`${parts[0]}/${parts[1]}`, parts.slice(2).join("/")];
  return [parts[0] || specifier, parts.slice(1).join("/")];
}
