import { createModuleRuntime, ModuleRuntime } from "./runtime.ts";
import type { ModuleRuntimeOptions, PackageExportTarget, PackageManifest, RuntimeValue } from "../types.ts";
import { join } from "../builtins/path.ts";
import { transpileTypeScript } from "../transforms/typescript.ts";

export interface WorkspaceModuleReader {
  readText(path: string): string;
  isFile?(path: string): boolean;
  listDir(path: string): string[];
}

export interface WorkspaceModuleRuntimeOptions extends Omit<ModuleRuntimeOptions, "packages"> {
  reader: WorkspaceModuleReader;
  root?: string;
  packages?: Record<string, PackageManifest>;
}

export function createWorkspaceModuleRuntime(options: WorkspaceModuleRuntimeOptions): ModuleRuntime {
  const root = trimSlash(options.root || "/workspace");
  const discovered = discoverPackageManifests(options.reader, root);
  const packages = {
    ...discovered.packages,
    ...(options.packages || {})
  };
  const packageRoots = {
    ...discovered.packageRoots,
    ...(options.packageRoots || {})
  };
  const runtime = createModuleRuntime({
    ...(options.allowAsyncRequireEsm !== undefined ? { allowAsyncRequireEsm: options.allowAsyncRequireEsm } : {}),
    ...(options.builtins ? { builtins: options.builtins } : {}),
    ...(options.globals ? { globals: options.globals } : {}),
    ...(options.imports ? { imports: options.imports } : {}),
    packages,
    packageRoots,
    loadModuleDefinition: (url) => readWorkspaceModuleDefinition(options.reader, root, url),
    moduleExists: (url) => options.reader.isFile?.(url) === true,
    ...(options.realpaths ? { realpaths: options.realpaths } : {})
  });

  if (!options.reader.isFile) registerWorkspaceModules(runtime, options.reader, root);
  return runtime;
}

export function registerWorkspaceModules(runtime: ModuleRuntime, reader: WorkspaceModuleReader, root = "/workspace"): ModuleRuntime {
  for (const file of walkFiles(reader, trimSlash(root))) {
    const definition = readWorkspaceModuleDefinition(reader, trimSlash(root), file);
    if (definition) runtime.register(file, definition);
  }
  return runtime;
}

function readWorkspaceModuleDefinition(reader: WorkspaceModuleReader, root: string, file: string) {
  const normalizedRoot = trimSlash(root);
  if (file !== normalizedRoot && !file.startsWith(`${normalizedRoot}/`)) return undefined;
  if (isEsmSourceFile(reader, file)) {
    const source = safeReadText(reader, file);
    return source === null ? undefined : {
      kind: "esm-source" as const,
      source: isTypeScriptSourceFile(file) ? transpileTypeScript(source, { fileName: file }).code : source
    };
  }
  if (file.endsWith(".cjs") || file.endsWith(".cts") || file.endsWith(".js") || isExtensionlessExecutable(reader, file)) {
    const source = safeReadText(reader, file);
    return source === null ? undefined : {
      kind: "cjs-source" as const,
      source: file.endsWith(".cts") ? transpileTypeScript(source, { fileName: file }).code : source
    };
  }
  if (file.endsWith(".json")) {
    const value = tryReadJson<RuntimeValue>(reader, file);
    if (value === undefined) return undefined;
    return {
      kind: "json" as const,
      value
    };
  }
  return undefined;
}

function discoverPackageManifests(reader: WorkspaceModuleReader, root: string): { packages: Record<string, PackageManifest>; packageRoots: Record<string, PackageManifest> } {
  const packages: Record<string, PackageManifest> = {};
  const packageRoots: Record<string, PackageManifest> = {};
  for (const file of walkFiles(reader, root)) {
    if (!file.endsWith("/package.json")) continue;
    const packageRoot = file.slice(0, -"/package.json".length);
    const name = packageNameFromNodeModulesPath(packageRoot);
    if (!name) continue;

    const manifest = tryReadJson<PackageJson>(reader, file);
    if (!manifest) continue;
    const packageManifest = {
      name,
      root: packageRoot,
      ...(typeof manifest.type === "string" ? { type: manifest.type } : {}),
      ...(typeof manifest.main === "string" ? { main: manifest.main } : {}),
      ...normalizeBrowser(manifest.browser),
      ...normalizeExports(manifest.exports),
      ...normalizeImports(manifest.imports)
    };
    packages[name] = packageManifest;
    packageRoots[packageRoot] = packageManifest;
  }
  return { packages, packageRoots };
}

function* walkFiles(reader: WorkspaceModuleReader, path: string): Generator<string> {
  for (const entry of safeListDir(reader, path)) {
    const child = join(path, entry);
    if (reader.isFile?.(child) === true) {
      yield child;
      continue;
    }
    if (isLikelyTextModule(child) && safeReadText(reader, child) !== null) {
      yield child;
      continue;
    }
    if (isExtensionlessExecutable(reader, child)) {
      yield child;
      continue;
    }
    yield* walkFiles(reader, child);
  }
}

function isExtensionlessExecutable(reader: WorkspaceModuleReader, path: string): boolean {
  if (path.split("/").at(-1)?.includes(".")) return false;
  return safeReadText(reader, path)?.startsWith("#!") === true;
}

function safeListDir(reader: WorkspaceModuleReader, path: string): string[] {
  try {
    return reader.listDir(path);
  } catch {
    return [];
  }
}

function safeReadText(reader: WorkspaceModuleReader, path: string): string | null {
  try {
    return reader.readText(path);
  } catch {
    return null;
  }
}

function isLikelyTextModule(path: string): boolean {
  if (path.endsWith(".d.ts") || path.endsWith(".d.mts") || path.endsWith(".d.cts")) return false;
  return path.endsWith(".js")
    || path.endsWith(".cjs")
    || path.endsWith(".mjs")
    || path.endsWith(".ts")
    || path.endsWith(".tsx")
    || path.endsWith(".cts")
    || path.endsWith(".mts")
    || path.endsWith(".json");
}

function isEsmSourceFile(reader: WorkspaceModuleReader, path: string): boolean {
  if (path.endsWith(".mts") || path.endsWith(".tsx") || path.endsWith(".ts")) return true;
  if (path.endsWith(".mjs")) return true;
  if (!path.endsWith(".js")) return false;
  return nearestPackageType(reader, path) === "module";
}

function isTypeScriptSourceFile(path: string): boolean {
  return path.endsWith(".ts") || path.endsWith(".tsx") || path.endsWith(".mts");
}

function nearestPackageType(reader: WorkspaceModuleReader, path: string): string | null {
  let current = path.slice(0, path.lastIndexOf("/")) || "/";
  while (current !== "/") {
    const manifest = safeReadText(reader, join(current, "package.json"));
    if (manifest) {
      try {
        const parsed = JSON.parse(manifest) as { type?: unknown };
        return typeof parsed.type === "string" ? parsed.type : null;
      } catch {
        return null;
      }
    }
    current = current.slice(0, current.lastIndexOf("/")) || "/";
  }
  return null;
}

function packageNameFromNodeModulesPath(packageRoot: string): string | null {
  const marker = "/node_modules/";
  const index = packageRoot.lastIndexOf(marker);
  if (index < 0) return null;
  const relative = packageRoot.slice(index + marker.length);
  const parts = relative.split("/");
  if (!parts[0]) return null;
  if (parts[0].startsWith("@")) return parts[1] ? `${parts[0]}/${parts[1]}` : null;
  return parts[0];
}

function normalizeExports(exportsMap: PackageJson["exports"]): Pick<PackageManifest, "exports"> {
  if (typeof exportsMap === "string") return { exports: exportsMap };
  const normalized = normalizeExportTarget(exportsMap);
  return Object.keys(normalized).length > 0 ? { exports: normalized } : {};
}

function normalizeImports(importsMap: PackageJson["imports"]): Pick<PackageManifest, "imports"> {
  const normalized = normalizeExportTarget(importsMap);
  return Object.keys(normalized).length > 0 ? { imports: normalized } : {};
}

function normalizeBrowser(browser: PackageJson["browser"]): Pick<PackageManifest, "browser"> {
  if (typeof browser === "string") return { browser };
  if (!isRecord(browser)) return {};
  const normalized: Record<string, string | false> = {};
  for (const [key, value] of Object.entries(browser)) {
    if (typeof value === "string" || value === false) normalized[key] = value;
  }
  return Object.keys(normalized).length > 0 ? { browser: normalized } : {};
}

function normalizeExportTarget(value: unknown): Record<string, PackageExportTarget> {
  if (!isRecord(value)) return {};
  const normalized: Record<string, PackageExportTarget> = {};
  for (const [key, target] of Object.entries(value)) {
    const normalizedTarget = normalizeExportTargetValue(target);
    if (normalizedTarget !== undefined) normalized[key] = normalizedTarget;
  }
  return normalized;
}

function normalizeExportTargetValue(value: unknown): PackageExportTarget | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(normalizeExportTargetValue).filter((item): item is PackageExportTarget => item !== undefined);
  if (!isRecord(value)) return undefined;
  const normalized = normalizeExportTarget(value);
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function readJson<T>(reader: WorkspaceModuleReader, path: string): T {
  return JSON.parse(reader.readText(path)) as T;
}

function tryReadJson<T>(reader: WorkspaceModuleReader, path: string): T | undefined {
  try {
    return readJson<T>(reader, path);
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function trimSlash(path: string): string {
  return path.endsWith("/") && path !== "/" ? path.slice(0, -1) : path;
}

interface PackageJson {
  name?: unknown;
  type?: unknown;
  main?: unknown;
  browser?: unknown;
  exports?: unknown;
  imports?: unknown;
}
