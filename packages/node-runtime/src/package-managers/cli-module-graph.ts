import { dirname, join, normalize } from "../builtins/path.ts";

export interface CliModuleGraphReader {
  exists(path: string): boolean;
  isFile?(path: string): boolean;
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
  kind:
    | "unsupported-builtin"
    | "missing-module"
    | "dynamic-require"
    | "dynamic-command-dispatch"
    | "dynamic-config-probe"
    | "dynamic-adapter-dispatch"
    | "optional-native-probe"
    | "optional-cache-probe"
    | "optional-dependency-probe";
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
  "constants",
  "dns",
  "dns/promises",
  "events",
  "fs",
  "fs/promises",
  "http",
  "https",
  "module",
  "os",
  "path",
  "path/posix",
  "process",
  "querystring",
  "readline",
  "stream",
  "stream/promises",
  "string_decoder",
  "timers/promises",
  "tty",
  "url",
  "util",
  "zlib"
]);

const knownNodeBuiltins = new Set([
  "assert",
  "assert/strict",
  "async_hooks",
  "buffer",
  "child_process",
  "constants",
  "crypto",
  "dns",
  "dns/promises",
  "events",
  "fs",
  "fs/promises",
  "http",
  "http2",
  "https",
  "module",
  "net",
  "os",
  "path",
  "path/posix",
  "process",
  "querystring",
  "readline",
  "stream",
  "stream/promises",
  "string_decoder",
  "timers",
  "timers/promises",
  "tls",
  "tty",
  "url",
  "util",
  "v8",
  "worker_threads",
  "zlib"
]);

const optionalIssueKinds = new Set<CliModuleGraphIssue["kind"]>([
  "optional-native-probe",
  "optional-cache-probe",
  "optional-dependency-probe"
]);
const dynamicRequireSpecifier = "<dynamic>";

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
    const requires = extractStaticRequires(source, { filename: current });
    modules.push({ path: current, requires });
    for (const specifier of requires) {
      if (isBuiltin(specifier, builtins)) continue;
      if (specifier === dynamicRequireSpecifier || specifier.includes("${") || specifier.includes("+")) {
        issues.push({ specifier, importer: current, kind: classifyDynamicRequire(specifier, current) });
        continue;
      }
      const optionalKind = classifyOptionalProbe(specifier, current);
      if (optionalKind) {
        issues.push({ specifier, importer: current, kind: optionalKind });
        continue;
      }
      if (isKnownNodeBuiltin(specifier)) {
        issues.push({ specifier, importer: current, kind: "unsupported-builtin" });
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
    supported: issues.every((issue) => optionalIssueKinds.has(issue.kind))
  };
}

export interface StaticRequireExtractionOptions {
  filename?: string;
}

export function extractStaticRequires(source: string, options: StaticRequireExtractionOptions = {}): string[] {
  const requires = new Set<string>();
  const constants = collectStaticPathConstants(source, options.filename);

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];

    if (char === "'" || char === '"') {
      index = skipQuotedString(source, index, char);
      continue;
    }
    if (char === "`") {
      index = skipTemplateLiteral(source, index);
      continue;
    }
    if (char === "/" && source[index + 1] === "/") {
      index = skipLineComment(source, index);
      continue;
    }
    if (char === "/" && source[index + 1] === "*") {
      index = skipBlockComment(source, index);
      continue;
    }

    if (!source.startsWith("require", index)) continue;
    if (isIdentifierPart(source[index - 1]) || isIdentifierPart(source[index + "require".length])) continue;

    const parsed = parseRequireCall(source, index + "require".length, constants);
    if (parsed) {
      requires.add(parsed.specifier);
      index = parsed.end;
    }
  }

  return [...requires].sort();
}

function isBuiltin(specifier: string, builtins: Set<string>): boolean {
  const normalized = specifier.startsWith("node:") ? specifier.slice(5) : specifier;
  return builtins.has(normalized);
}

function isKnownNodeBuiltin(specifier: string): boolean {
  const normalized = specifier.startsWith("node:") ? specifier.slice(5) : specifier;
  return knownNodeBuiltins.has(normalized);
}

function resolveRequire(specifier: string, importer: string, packageRoot: string, reader: CliModuleGraphReader): string | null {
  if (specifier === "." || specifier === ".." || specifier.startsWith("./") || specifier.startsWith("../") || specifier.startsWith("/")) {
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
    `${normalized}.json`,
    `${normalized}.cjs`,
    `${normalized}.mjs`,
    join(normalized, "index.js"),
    join(normalized, "index.json"),
    join(normalized, "index.cjs"),
    join(normalized, "index.mjs")
  ];
  return candidates.find((candidate) => reader.exists(candidate) && (reader.isFile?.(candidate) ?? true)) || null;
}

function splitPackageSpecifier(specifier: string): [string, string] {
  const parts = specifier.split("/");
  if (specifier.startsWith("@")) return [`${parts[0]}/${parts[1]}`, parts.slice(2).join("/")];
  return [parts[0] || specifier, parts.slice(1).join("/")];
}

function classifyOptionalProbe(specifier: string, importer: string): CliModuleGraphIssue["kind"] | null {
  if (specifier.endsWith(".node") || specifier.startsWith("@reflink/")) return "optional-native-probe";
  if (specifier === "v8-compile-cache") return "optional-cache-probe";
  if (specifier === "../lib/pnpm" && importer.endsWith("/bin/pnpm.cjs")) return "optional-cache-probe";
  if (specifier === "./custom-prompt" && importer.endsWith("/dist/pnpm.cjs")) return "optional-cache-probe";
  if ((specifier === "esprima" || specifier === "supports-color") && importer.endsWith("/dist/pnpm.cjs")) {
    return "optional-dependency-probe";
  }
  if (specifier === "bluebird" && importer.endsWith("/node_modules/promise-inflight/inflight.js")) {
    return "optional-dependency-probe";
  }
  return null;
}

function classifyDynamicRequire(specifier: string, importer: string): CliModuleGraphIssue["kind"] {
  if (specifier.includes("./commands/") || importer.endsWith("/lib/npm.js")) return "dynamic-command-dispatch";
  if (importer.endsWith("/node_modules/@npmcli/config/lib/index.js")) return "dynamic-config-probe";
  if (importer.endsWith("/dist/pnpm.cjs")) return "dynamic-adapter-dispatch";
  return "dynamic-require";
}

function collectStaticPathConstants(source: string, filename: string | undefined): Map<string, string> {
  const constants = new Map<string, string>();
  if (!filename) return constants;

  const pathResolvePattern =
    /\b(?:const|let|var)\s+([$_\p{ID_Start}][$_\p{ID_Continue}]*)\s*=\s*require\(\s*['"]node:path['"]\s*\)\.resolve\(\s*__dirname\s*,\s*['"]([^'"]+)['"]\s*\)/gu;
  for (const match of source.matchAll(pathResolvePattern)) {
    const [, name, relativePath] = match;
    if (name && relativePath) constants.set(name, normalize(join(dirname(filename), relativePath)));
  }

  return constants;
}

function parseRequireCall(
  source: string,
  start: number,
  constants: Map<string, string>
): { specifier: string; end: number } | null {
  let index = skipWhitespace(source, start);
  if (source[index] !== "(") return null;
  index = skipWhitespace(source, index + 1);

  const quote = source[index];
  if (quote !== "'" && quote !== '"') {
    const end = source.indexOf(")", index);
    if (end === -1 || end - index > 64) return null;
    const expression = source.slice(index, end).trim();
    return { specifier: constants.get(expression) || dynamicRequireSpecifier, end };
  }

  const literalStart = index + 1;
  index = skipQuotedString(source, index, quote);
  const literalEnd = index;
  index = skipWhitespace(source, index + 1);
  if (source[index] !== ")") return null;

  return {
    specifier: source.slice(literalStart, literalEnd),
    end: index
  };
}

function skipWhitespace(source: string, start: number): number {
  let index = start;
  while (/\s/.test(source[index] || "")) index += 1;
  return index;
}

function skipQuotedString(source: string, start: number, quote: "'" | '"'): number {
  for (let index = start + 1; index < source.length; index += 1) {
    if (source[index] === "\\") {
      index += 1;
      continue;
    }
    if (source[index] === quote) return index;
  }
  return source.length - 1;
}

function skipTemplateLiteral(source: string, start: number): number {
  for (let index = start + 1; index < source.length; index += 1) {
    if (source[index] === "\\") {
      index += 1;
      continue;
    }
    if (source[index] === "`") return index;
  }
  return source.length - 1;
}

function skipLineComment(source: string, start: number): number {
  const end = source.indexOf("\n", start + 2);
  return end === -1 ? source.length - 1 : end;
}

function skipBlockComment(source: string, start: number): number {
  const end = source.indexOf("*/", start + 2);
  return end === -1 ? source.length - 1 : end + 1;
}

function isIdentifierPart(char: string | undefined): boolean {
  return !!char && /[$_\p{ID_Continue}]/u.test(char);
}
