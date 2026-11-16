const TSCONFIG_EXTENDS_LIMIT = 4;

export interface ProjectTypeScriptOptions {
  readonly allowJs: boolean;
  readonly allowSyntheticDefaultImports: boolean;
  readonly baseUrl: string | undefined;
  readonly checkJs: boolean;
  readonly esModuleInterop: boolean;
  readonly experimentalDecorators: boolean;
  readonly forceConsistentCasingInFileNames: boolean;
  readonly isolatedModules: boolean;
  readonly jsx: "preserve" | "react" | "react-jsx" | "react-jsxdev" | "react-native";
  readonly lib: readonly string[] | undefined;
  readonly module: "commonjs" | "esnext";
  readonly noUnusedLocals: boolean;
  readonly noUnusedParameters: boolean;
  readonly paths: Readonly<Record<string, readonly string[]>> | undefined;
  readonly resolveJsonModule: boolean;
  readonly skipLibCheck: boolean;
  readonly strict: boolean;
  readonly target: "es5" | "es2015" | "es2016" | "es2017" | "es2018" | "es2019" | "es2020" | "esnext";
}

interface JsonRecord {
  readonly [key: string]: unknown;
}

export function defaultProjectTypeScriptOptions(): ProjectTypeScriptOptions {
  return {
    allowJs: true,
    allowSyntheticDefaultImports: true,
    baseUrl: undefined,
    checkJs: false,
    esModuleInterop: true,
    experimentalDecorators: false,
    forceConsistentCasingInFileNames: true,
    isolatedModules: true,
    jsx: "preserve",
    lib: undefined,
    module: "esnext",
    noUnusedLocals: false,
    noUnusedParameters: false,
    paths: undefined,
    resolveJsonModule: true,
    skipLibCheck: true,
    strict: false,
    target: "esnext"
  };
}

export function packageNamesFromManifest(manifestText: string | undefined): readonly string[] {
  if (manifestText === undefined) return [];
  const manifest = parseJsonRecord(manifestText);
  if (manifest === undefined) return [];
  const names = new Set<string>();
  for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"] as const) {
    const dependencies = manifest[field];
    if (!isRecord(dependencies)) continue;
    for (const name of Object.keys(dependencies)) {
      if (!name.startsWith("@types/")) names.add(name);
    }
  }
  return [...names].toSorted();
}

export function projectTypeScriptOptionsFromWorkspace(readText: (path: string) => string | undefined): ProjectTypeScriptOptions {
  return tsconfigChain(readText).reduceRight(
    (options, source) => applyCompilerOptions(options, source),
    defaultProjectTypeScriptOptions()
  );
}

function tsconfigChain(readText: (path: string) => string | undefined): readonly string[] {
  const sources: string[] = [];
  const seen = new Set<string>();
  let path = "tsconfig.json";
  for (let depth = 0; depth < TSCONFIG_EXTENDS_LIMIT; depth += 1) {
    if (seen.has(path)) break;
    seen.add(path);
    const source = readText(path);
    if (source === undefined) break;
    sources.push(source);
    const nextPath = relativeExtendsPath(source, path);
    if (nextPath === undefined) break;
    path = nextPath;
  }
  return sources;
}

function applyCompilerOptions(base: ProjectTypeScriptOptions, source: string): ProjectTypeScriptOptions {
  const compilerOptions = compilerOptionsRecord(source);
  if (compilerOptions === undefined) return base;
  const jsx = jsxOption(compilerOptions.jsx);
  const lib = "lib" in compilerOptions ? stringArray(compilerOptions.lib) : undefined;
  const moduleKind = moduleOption(compilerOptions.module);
  const target = targetOption(compilerOptions.target);
  return {
    allowJs: booleanOption(compilerOptions, "allowJs", base.allowJs),
    allowSyntheticDefaultImports: booleanOption(compilerOptions, "allowSyntheticDefaultImports", base.allowSyntheticDefaultImports),
    baseUrl: typeof compilerOptions.baseUrl === "string" ? compilerOptions.baseUrl : base.baseUrl,
    checkJs: booleanOption(compilerOptions, "checkJs", base.checkJs),
    esModuleInterop: booleanOption(compilerOptions, "esModuleInterop", base.esModuleInterop),
    experimentalDecorators: booleanOption(compilerOptions, "experimentalDecorators", base.experimentalDecorators),
    forceConsistentCasingInFileNames: booleanOption(compilerOptions, "forceConsistentCasingInFileNames", base.forceConsistentCasingInFileNames),
    isolatedModules: booleanOption(compilerOptions, "isolatedModules", base.isolatedModules),
    jsx: jsx ?? base.jsx,
    lib: lib === undefined ? base.lib : lib,
    module: moduleKind ?? base.module,
    noUnusedLocals: booleanOption(compilerOptions, "noUnusedLocals", base.noUnusedLocals),
    noUnusedParameters: booleanOption(compilerOptions, "noUnusedParameters", base.noUnusedParameters),
    paths: "paths" in compilerOptions ? pathsOption(compilerOptions.paths) : base.paths,
    resolveJsonModule: booleanOption(compilerOptions, "resolveJsonModule", base.resolveJsonModule),
    skipLibCheck: booleanOption(compilerOptions, "skipLibCheck", base.skipLibCheck),
    strict: booleanOption(compilerOptions, "strict", base.strict),
    target: target ?? base.target
  };
}

function compilerOptionsRecord(source: string): JsonRecord | undefined {
  const record = parseJsonRecord(source);
  if (record === undefined) return undefined;
  return isRecord(record.compilerOptions) ? record.compilerOptions : undefined;
}

function relativeExtendsPath(source: string, fromFile: string): string | undefined {
  const record = parseJsonRecord(source);
  if (record === undefined || typeof record.extends !== "string") return undefined;
  if (!record.extends.startsWith("./") && !record.extends.startsWith("../")) return undefined;
  const nextPath = normalizeRelativePath(fromFile, record.extends);
  if (nextPath === undefined || nextPath.split("/").includes("node_modules")) return undefined;
  return nextPath.endsWith(".json") ? nextPath : `${nextPath}.json`;
}

function normalizeRelativePath(fromFile: string, specifier: string): string | undefined {
  const parts = fromFile.split("/").slice(0, -1);
  for (const segment of specifier.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (parts.length === 0) return undefined;
      parts.pop();
      continue;
    }
    parts.push(segment);
  }
  return parts.join("/");
}

function parseJsonRecord(source: string): JsonRecord | undefined {
  try {
    const parsed: unknown = JSON.parse(stripJsonComments(source).replace(/,(\s*[}\]])/gu, "$1"));
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function stripJsonComments(source: string): string {
  let result = "";
  let index = 0;
  let quote: "\"" | "'" | null = null;
  while (index < source.length) {
    const current = source[index] ?? "";
    const next = source[index + 1];
    if (quote !== null) {
      result += current;
      if (current === "\\") {
        if (next !== undefined) result += next;
        index += next === undefined ? 1 : 2;
        continue;
      }
      if (current === quote) quote = null;
      index += 1;
      continue;
    }
    if (current === "\"" || current === "'") {
      quote = current;
      result += current;
      index += 1;
      continue;
    }
    if (current === "/" && next === "/") {
      index += 2;
      while (index < source.length && source[index] !== "\n") index += 1;
      continue;
    }
    if (current === "/" && next === "*") {
      index += 2;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) index += 1;
      index += 2;
      continue;
    }
    result += current;
    index += 1;
  }
  return result;
}

function jsxOption(value: unknown): ProjectTypeScriptOptions["jsx"] | undefined {
  if (value === "preserve" || value === "react" || value === "react-jsx" || value === "react-jsxdev" || value === "react-native") return value;
  return undefined;
}

function moduleOption(value: unknown): ProjectTypeScriptOptions["module"] | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.toLocaleLowerCase();
  if (normalized === "commonjs") return "commonjs";
  if (normalized === "es2015" || normalized === "es2020" || normalized === "es2022" || normalized === "esnext" || normalized === "node16" || normalized === "nodenext" || normalized === "preserve") return "esnext";
  return undefined;
}

function targetOption(value: unknown): ProjectTypeScriptOptions["target"] | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.toLocaleLowerCase();
  if (normalized === "es5") return "es5";
  if (normalized === "es6" || normalized === "es2015") return "es2015";
  if (normalized === "es2016") return "es2016";
  if (normalized === "es2017") return "es2017";
  if (normalized === "es2018") return "es2018";
  if (normalized === "es2019") return "es2019";
  if (normalized === "es2020") return "es2020";
  if (normalized === "es2021" || normalized === "es2022" || normalized === "es2023" || normalized === "esnext") return "esnext";
  return undefined;
}

function pathsOption(value: unknown): Readonly<Record<string, readonly string[]>> {
  if (!isRecord(value)) return {};
  const paths: Record<string, readonly string[]> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!Array.isArray(entry) || !entry.every((item) => typeof item === "string")) continue;
    paths[key] = entry;
  }
  return paths;
}

function stringArray(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) return undefined;
  return value;
}

function booleanOption(record: JsonRecord, key: string, fallback: boolean): boolean {
  const value = record[key];
  return typeof value === "boolean" ? value : fallback;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
