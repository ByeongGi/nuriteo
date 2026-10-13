import { dirname, join, normalize } from "../builtins/path.ts";

export interface CliModuleGraphReader {
  exists(path: string): boolean;
  isFile?(path: string): boolean;
  listFiles?(path: string): string[];
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
  imports: string[];
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

type GraphPackageExports = GraphPackageExportTarget | Record<string, GraphPackageExportTarget | undefined>;
type GraphPackageExportTarget = string | GraphPackageExportTarget[] | { [condition: string]: GraphPackageExportTarget | undefined };

interface GraphPackageManifest {
  name?: string;
  main?: string;
  browser?: string | Record<string, string | false>;
  exports?: GraphPackageExports;
  imports?: GraphPackageExports;
}

const defaultBuiltins = new Set([
  "assert",
  "assert/strict",
  "async_hooks",
  "buffer",
  "child_process",
  "constants",
  "console",
  "crypto",
  "dns",
  "dns/promises",
  "diagnostics_channel",
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
  "perf_hooks",
  "process",
  "querystring",
  "readline",
  "stream",
  "stream/promises",
  "stream/web",
  "string_decoder",
  "timers",
  "timers/promises",
  "tls",
  "tty",
  "url",
  "util",
  "util/types",
  "v8",
  "vm",
  "wasi",
  "worker_threads",
  "zlib"
]);

const knownNodeBuiltins = new Set([
  "assert",
  "assert/strict",
  "async_hooks",
  "buffer",
  "child_process",
  "constants",
  "console",
  "crypto",
  "dns",
  "dns/promises",
  "diagnostics_channel",
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
  "perf_hooks",
  "process",
  "querystring",
  "readline",
  "stream",
  "stream/promises",
  "stream/web",
  "string_decoder",
  "timers",
  "timers/promises",
  "tls",
  "tty",
  "url",
  "util",
  "util/types",
  "v8",
  "vm",
  "wasi",
  "worker_threads",
  "zlib"
]);

const optionalIssueKinds = new Set<CliModuleGraphIssue["kind"]>([
  "optional-native-probe",
  "optional-cache-probe",
  "optional-dependency-probe"
]);
const dynamicRequireSpecifier = "<dynamic>";
const productNpmCommandFiles = new Set(["ci.js", "exec.js", "install.js", "run-script.js"]);

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
    const imports = extractStaticEsmSpecifiers(source);
    modules.push({ path: current, requires, imports });
    const dependencies = [
      ...requires.map((specifier) => ({ specifier, conditions: ["browser", "require", "node", "default", "import"] })),
      ...imports.map((specifier) => ({ specifier, conditions: ["browser", "import", "node", "default", "require"] }))
    ];
    for (const { specifier, conditions } of dependencies) {
      if (isBuiltin(specifier, builtins)) continue;
      if (specifier === dynamicRequireSpecifier || specifier.includes("${") || specifier.includes("+")) {
        const resolvedCandidates = resolveDynamicRequireCandidates(specifier, current, options.reader);
        if (resolvedCandidates.length > 0) {
          queue.push(...resolvedCandidates);
          continue;
        }
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
      const resolved = resolveModuleSpecifier(specifier, current, options.packageRoot, options.reader, conditions);
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
  source = maskJSDocComments(source);
  source = maskJavaScriptComments(source);
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
    if (isIdentifierPart(source[index - 1]) || source[index - 1] === "." || isIdentifierPart(source[index + "require".length])) continue;

    const parsed = parseRequireCall(source, index + "require".length, constants, options.filename);
    if (parsed) {
      requires.add(parsed.specifier);
      index = parsed.end;
    }
  }

  return [...requires].sort();
}

export function extractStaticEsmSpecifiers(source: string): string[] {
  source = maskJSDocComments(source);
  source = maskJavaScriptComments(source);
  const imports = new Set<string>();

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

    if (source.startsWith("import", index) && !isIdentifierPart(source[index - 1]) && !isIdentifierPart(source[index + "import".length])) {
      const dynamic = parseDynamicImport(source, index + "import".length);
      if (dynamic) {
        imports.add(dynamic.specifier);
        index = dynamic.end;
        continue;
      }
    }

    if (source.startsWith("import", index) && isStaticModuleKeywordStart(source, index) && !isIdentifierPart(source[index + "import".length])) {
      const parsed = parseStaticImport(source, index + "import".length);
      if (parsed) {
        imports.add(parsed.specifier);
        index = parsed.end;
      }
      continue;
    }

    if (source.startsWith("export", index) && isStaticModuleKeywordStart(source, index) && !isIdentifierPart(source[index + "export".length])) {
      const parsed = parseStaticExport(source, index + "export".length);
      if (parsed) {
        imports.add(parsed.specifier);
        index = parsed.end;
      }
    }
  }

  return [...imports].sort();
}

function isBuiltin(specifier: string, builtins: Set<string>): boolean {
  const normalized = specifier.startsWith("node:") ? specifier.slice(5) : specifier;
  return builtins.has(normalized);
}

function isKnownNodeBuiltin(specifier: string): boolean {
  const normalized = specifier.startsWith("node:") ? specifier.slice(5) : specifier;
  return knownNodeBuiltins.has(normalized);
}

function parseDynamicImport(source: string, index: number): { specifier: string; end: number } | null {
  let cursor = skipWhitespace(source, index);
  if (source[cursor] !== "(") return null;
  cursor = skipWhitespace(source, cursor + 1);
  const quote = source[cursor];
  if (quote !== "'" && quote !== "\"") return null;
  const specifierStart = cursor + 1;
  cursor = skipQuotedString(source, cursor, quote);
  const specifier = source.slice(specifierStart, cursor);
  cursor = skipWhitespace(source, cursor + 1);
  if (source[cursor] !== ")") return null;
  return { specifier, end: cursor };
}

function resolveModuleSpecifier(specifier: string, importer: string, packageRoot: string, reader: CliModuleGraphReader, conditions: readonly string[]): string | null {
  if (specifier.startsWith("#")) return resolvePackageImport(specifier, importer, packageRoot, reader, conditions);
  if (specifier === "." || specifier === ".." || specifier.startsWith("./") || specifier.startsWith("../") || specifier.startsWith("/")) {
    const base = specifier.startsWith("/") ? specifier : join(dirname(importer), specifier);
    return resolveFileOrDirectory(base, reader);
  }
  return resolvePackage(specifier, importer, packageRoot, reader, conditions);
}

function resolvePackage(specifier: string, importer: string, packageRoot: string, reader: CliModuleGraphReader, conditions: readonly string[]): string | null {
  const [name, subpath] = splitPackageSpecifier(specifier);
  const packageManifestPath = join(packageRoot, "package.json");
  if (reader.exists(packageManifestPath)) {
    const packageManifest = JSON.parse(reader.readText(packageManifestPath)) as GraphPackageManifest;
    if (packageManifest.name === name) {
      const selfReference = resolvePackageTarget(packageRoot, subpath ? `./${subpath}` : ".", reader, conditions);
      if (selfReference) return selfReference;
    }
  }
  let current = dirname(importer);
  while (true) {
    const root = join(current, "node_modules", name);
    const resolved = resolvePackageTarget(root, subpath ? `./${subpath}` : ".", reader, conditions);
    if (resolved) return resolved;
    const next = dirname(current);
    if (next === current || !current.startsWith(packageRoot)) break;
    current = next;
  }
  current = dirname(packageRoot);
  while (true) {
    const root = join(current, "node_modules", name);
    const resolved = resolvePackageTarget(root, subpath ? `./${subpath}` : ".", reader, conditions);
    if (resolved) return resolved;
    const next = dirname(current);
    if (next === current) break;
    current = next;
  }
  return resolvePackageTarget(join(packageRoot, "node_modules", name), subpath ? `./${subpath}` : ".", reader, conditions);
}

function resolvePackageImport(specifier: string, importer: string, packageRoot: string, reader: CliModuleGraphReader, conditions: readonly string[]): string | null {
  const root = findContainingPackageRoot(importer, packageRoot, reader);
  if (!root) return null;
  const manifestPath = join(root, "package.json");
  if (!reader.exists(manifestPath)) return null;
  const manifest = JSON.parse(reader.readText(manifestPath)) as GraphPackageManifest;
  if (!manifest.imports) return null;
  const target = resolvePackageExportTarget(manifest.imports, specifier, conditions);
  if (!target) return null;
  if (target.startsWith("./") || target.startsWith("../")) return resolveFileOrDirectory(join(root, target), reader);
  return resolveModuleSpecifier(target, importer, packageRoot, reader, conditions);
}

function findContainingPackageRoot(importer: string, packageRoot: string, reader: CliModuleGraphReader): string | null {
  let current = dirname(importer);
  while (current.startsWith(packageRoot)) {
    if (reader.exists(join(current, "package.json"))) return current;
    const next = dirname(current);
    if (next === current) break;
    current = next;
  }
  return null;
}

function resolvePackageTarget(root: string, subpath: string, reader: CliModuleGraphReader, conditions: readonly string[]): string | null {
  const manifestPath = join(root, "package.json");
  if (reader.exists(manifestPath)) {
    const manifest = JSON.parse(reader.readText(manifestPath)) as GraphPackageManifest;
    if (manifest.exports) {
      const target = resolvePackageExportTarget(manifest.exports, subpath, conditions);
      if (!target) return null;
      return resolveFileOrDirectory(join(root, target), reader);
    }
    if (subpath === ".") {
      const resolved = resolveFileOrDirectory(join(root, resolveBrowserMainTarget(manifest, conditions) || manifest.main || "index.js"), reader);
      if (resolved) return resolved;
    }
  }
  if (subpath !== ".") return resolveFileOrDirectory(join(root, subpath.slice(2)), reader);
  return resolveFileOrDirectory(join(root, "index"), reader);
}

function resolveBrowserMainTarget(manifest: GraphPackageManifest, conditions: readonly string[]): string | undefined {
  if (!conditions.includes("browser")) return undefined;
  if (typeof manifest.browser === "string") return manifest.browser;
  if (!manifest.browser || typeof manifest.browser !== "object") return undefined;
  const main = manifest.main || "index.js";
  const mapped = manifest.browser[main] ?? manifest.browser[`./${main}`];
  return mapped && typeof mapped === "string" ? mapped : undefined;
}

function resolvePackageExportTarget(exportsMap: GraphPackageExports, subpath: string, conditions: readonly string[]): string | null {
  const target = selectPackageExportTarget(exportsMap, subpath);
  const resolved = target === undefined ? undefined : resolveConditionalExportTarget(target, conditions);
  return typeof resolved === "string" ? resolved : null;
}

function selectPackageExportTarget(exportsMap: GraphPackageExports, subpath: string): GraphPackageExportTarget | undefined {
  if (typeof exportsMap === "string" || Array.isArray(exportsMap)) return subpath === "." ? exportsMap : undefined;
  const exact = exportsMap[subpath];
  if (exact) return exact;
  if (isConditionalExportMap(exportsMap)) return subpath === "." ? exportsMap : undefined;
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

function resolveConditionalExportTarget(target: GraphPackageExportTarget, conditions: readonly string[]): GraphPackageExportTarget | undefined {
  if (typeof target === "string") return target;
  if (Array.isArray(target)) {
    for (const item of target) {
      const resolved = resolveConditionalExportTarget(item, conditions);
      if (resolved) return resolved;
    }
    return undefined;
  }
  for (const condition of conditions) {
    const resolved = target[condition] ? resolveConditionalExportTarget(target[condition], conditions) : undefined;
    if (resolved) return resolved;
  }
  return undefined;
}

function replaceExportPatternTarget(target: GraphPackageExportTarget, matched: string): GraphPackageExportTarget {
  if (typeof target === "string") return target.replaceAll("*", matched);
  if (Array.isArray(target)) return target.map((item) => replaceExportPatternTarget(item, matched));
  const replaced: Record<string, GraphPackageExportTarget> = {};
  for (const [condition, value] of Object.entries(target)) {
    if (value !== undefined) replaced[condition] = replaceExportPatternTarget(value, matched);
  }
  return replaced;
}

function isConditionalExportMap(exportsMap: Record<string, GraphPackageExportTarget | undefined>): boolean {
  return Object.keys(exportsMap).some((key) => !key.startsWith("."));
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
  const resolvedFile = candidates.find((candidate) => reader.exists(candidate) && (reader.isFile?.(candidate) ?? true));
  if (resolvedFile) return resolvedFile;
  const manifestPath = join(normalized, "package.json");
  if (!reader.exists(manifestPath) || !(reader.isFile?.(manifestPath) ?? true)) return null;
  try {
    const manifest = JSON.parse(reader.readText(manifestPath)) as GraphPackageManifest;
    if (!manifest.main || manifest.main === ".") return null;
    return resolveFileOrDirectory(join(normalized, manifest.main), reader);
  } catch {
    return null;
  }
}

function splitPackageSpecifier(specifier: string): [string, string] {
  const parts = specifier.split("/");
  if (specifier.startsWith("@")) return [`${parts[0]}/${parts[1]}`, parts.slice(2).join("/")];
  return [parts[0] || specifier, parts.slice(1).join("/")];
}

function classifyOptionalProbe(specifier: string, importer: string): CliModuleGraphIssue["kind"] | null {
  if (specifier.endsWith(".node") || specifier.startsWith("@reflink/")) return "optional-native-probe";
  if (specifier === "node:inspector" && importer.endsWith("/bin/vite.js")) return "optional-dependency-probe";
  if (specifier.startsWith("@vitejs/devtools/") && importer.includes("/node_modules/vite/")) return "optional-dependency-probe";
  if ((specifier === "jiti" || specifier === "lightningcss") && importer.includes("/node_modules/vite/")) return "optional-dependency-probe";
  if ((specifier === "yaml" || specifier.startsWith("tsx/")) && importer.includes("/node_modules/vite/")) return "optional-dependency-probe";
  if (specifier === "pnpapi") return "optional-dependency-probe";
  if ((specifier === "bufferutil" || specifier === "utf-8-validate") && importer.includes("/node_modules/ws/")) return "optional-native-probe";
  if (
    (specifier === "<keyv-adapter>" || specifier === "<pnpmfile>" || specifier === "<project-package-json>") &&
    importer.endsWith("/dist/pnpm.cjs")
  ) {
    return "optional-dependency-probe";
  }
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
  constants: Map<string, string>,
  filename: string | undefined
): { specifier: string; end: number } | null {
  let index = skipWhitespace(source, start);
  if (source[index] !== "(") return null;
  index = skipWhitespace(source, index + 1);

  const quote = source[index];
  if (quote === "`") {
    const literalStart = index + 1;
    index = skipTemplateLiteral(source, index);
    const literalEnd = index;
    index = skipWhitespace(source, index + 1);
    if (source[index] !== ")") return null;
    return {
      specifier: source.slice(literalStart, literalEnd),
      end: index
    };
  }

  if (quote !== "'" && quote !== '"') {
    const end = findClosingParen(source, index);
    if (end === -1 || end - index > 64) return null;
    const expression = source.slice(index, end).trim();
    return { specifier: constants.get(expression) || resolveKnownRequireExpression(expression, filename) || classifyKnownDynamicExpression(expression) || dynamicRequireSpecifier, end };
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

function parseStaticImport(source: string, start: number): { specifier: string; end: number } | null {
  let index = skipWhitespace(source, start);
  const quote = source[index];
  if (quote === "'" || quote === '"') {
    const specifierStart = index + 1;
    index = skipQuotedString(source, index, quote);
    return { specifier: source.slice(specifierStart, index), end: index };
  }
  if (source[index] === "(" || source[index] === ".") return null;

  const statementEnd = findStatementEnd(source, index);
  const statement = source.slice(index, statementEnd);
  const from = statement.match(/\bfrom\s*(['"])([^'"]+)\1/);
  if (!from?.[2]) return null;
  return {
    specifier: from[2],
    end: statementEnd
  };
}

function parseStaticExport(source: string, start: number): { specifier: string; end: number } | null {
  let index = skipWhitespace(source, start);
  if (source[index] !== "*" && source[index] !== "{") return null;

  const statementEnd = findStatementEnd(source, index);
  const statement = source.slice(index, statementEnd);
  const from = statement.match(/\bfrom\s*(['"])([^'"]+)\1/);
  if (!from?.[2]) return null;
  return {
    specifier: from[2],
    end: statementEnd
  };
}

function resolveKnownRequireExpression(expression: string, filename: string | undefined): string | null {
  if (
    filename?.endsWith("/node_modules/@npmcli/config/lib/index.js") &&
    /^join\(this\.npmPath,\s*['"]package\.json['"]\)$/.test(expression)
  ) {
    const nodeModulesIndex = filename.lastIndexOf("/node_modules/@npmcli/config/");
    if (nodeModulesIndex > 0) return join(filename.slice(0, nodeModulesIndex), "package.json");
  }
  return null;
}

function classifyKnownDynamicExpression(expression: string): string | null {
  if (expression === "adapters[adapter]") return "<keyv-adapter>";
  if (expression === "pnpmFilePath") return "<pnpmfile>";
  if (expression === "packageJsonPath") return "<project-package-json>";
  if (/join\)\(packageDir,\s*["']package\.json["']\)$/.test(expression)) return "<project-package-json>";
  return null;
}

function findClosingParen(source: string, start: number): number {
  let depth = 1;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (char === "'" || char === '"') {
      index = skipQuotedString(source, index, char);
      continue;
    }
    if (char === "`") {
      index = skipTemplateLiteral(source, index);
      continue;
    }
    if (char === "(") depth += 1;
    if (char === ")") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function findStatementEnd(source: string, start: number): number {
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (char === "'" || char === '"') {
      index = skipQuotedString(source, index, char);
      continue;
    }
    if (char === "`") {
      index = skipTemplateLiteral(source, index);
      continue;
    }
    if (char === ";") return index;
    if (char === "\n") return index;
  }
  return source.length;
}

function resolveDynamicRequireCandidates(specifier: string, importer: string, reader: CliModuleGraphReader): string[] {
  if (specifier === "./commands/${command}.js" && importer.endsWith("/lib/npm.js") && reader.listFiles) {
    const commandsDir = join(dirname(importer), "commands");
    return reader.listFiles(commandsDir)
      .filter((file) => file.endsWith(".js"))
      .filter((file) => productNpmCommandFiles.has(file))
      .map((file) => join(commandsDir, file))
      .filter((file) => reader.exists(file) && (reader.isFile?.(file) ?? true))
      .sort();
  }
  return [];
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

function maskJavaScriptComments(source: string): string {
  let output = "";
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (char === "'" || char === '"') {
      const end = skipQuotedString(source, index, char);
      output += source.slice(index, end + 1);
      index = end;
      continue;
    }
    if (char === "`") {
      const end = skipTemplateLiteral(source, index);
      output += source.slice(index, end + 1);
      index = end;
      continue;
    }
    if (char === "/" && source[index + 1] === "/") {
      const end = skipLineComment(source, index);
      output += maskCommentSlice(source.slice(index, end + 1));
      index = end;
      continue;
    }
    if (char === "/" && source[index + 1] === "*") {
      const end = skipBlockComment(source, index);
      output += maskCommentSlice(source.slice(index, end + 1));
      index = end;
      continue;
    }
    output += char;
  }
  return output;
}

function maskJSDocComments(source: string): string {
  return source.replace(/\/\*\*[\s\S]*?\*\//g, (comment) => maskCommentSlice(comment));
}

function maskCommentSlice(comment: string): string {
  return comment.replace(/[^\n\r]/g, " ");
}

function isIdentifierPart(char: string | undefined): boolean {
  return !!char && /[$_\p{ID_Continue}]/u.test(char);
}

function isStaticModuleKeywordStart(source: string, index: number): boolean {
  if (isIdentifierPart(source[index - 1])) return false;
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const char = source[cursor];
    if (char === " " || char === "\t" || char === "\r") continue;
    return char === "\n" || char === ";" || char === "{" || char === "}";
  }
  return true;
}
