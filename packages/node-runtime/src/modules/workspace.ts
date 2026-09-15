import { createModuleRuntime, ModuleRuntime } from "./runtime.ts";
import type { ModuleRuntimeOptions, PackageExportTarget, PackageManifest, RuntimeValue } from "../types.ts";
import { join } from "../builtins/path.ts";

export interface WorkspaceModuleReader {
  readText(path: string): string;
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
    ...(options.builtins ? { builtins: options.builtins } : {}),
    ...(options.globals ? { globals: options.globals } : {}),
    ...(options.imports ? { imports: options.imports } : {}),
    packages,
    packageRoots,
    ...(options.realpaths ? { realpaths: options.realpaths } : {})
  });

  registerWorkspaceModules(runtime, options.reader, root);
  return runtime;
}

export function registerWorkspaceModules(runtime: ModuleRuntime, reader: WorkspaceModuleReader, root = "/workspace"): ModuleRuntime {
  for (const file of walkFiles(reader, trimSlash(root))) {
    if (isEsmSourceFile(reader, file)) {
      runtime.register(file, {
        kind: "esm-source",
        source: reader.readText(file)
      });
    } else if (file.endsWith(".cjs") || file.endsWith(".js")) {
      runtime.register(file, {
        kind: "cjs-source",
        source: reader.readText(file)
      });
    } else if (file.endsWith(".json")) {
      runtime.register(file, {
        kind: "json",
        value: readJson<RuntimeValue>(reader, file)
      });
    }
  }
  return runtime;
}

function discoverPackageManifests(reader: WorkspaceModuleReader, root: string): { packages: Record<string, PackageManifest>; packageRoots: Record<string, PackageManifest> } {
  const packages: Record<string, PackageManifest> = {};
  const packageRoots: Record<string, PackageManifest> = {};
  for (const file of walkFiles(reader, root)) {
    if (!file.endsWith("/package.json")) continue;
    const packageRoot = file.slice(0, -"/package.json".length);
    const name = packageNameFromNodeModulesPath(packageRoot);
    if (!name) continue;

    const manifest = readJson<PackageJson>(reader, file);
    const packageManifest = {
      name,
      root: packageRoot,
      ...(typeof manifest.type === "string" ? { type: manifest.type } : {}),
      ...(typeof manifest.main === "string" ? { main: manifest.main } : {}),
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
    if (isLikelyTextModule(child) && safeReadText(reader, child) !== null) {
      yield child;
      continue;
    }
    yield* walkFiles(reader, child);
  }
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
  return path.endsWith(".js") || path.endsWith(".cjs") || path.endsWith(".mjs") || path.endsWith(".json");
}

function isEsmSourceFile(reader: WorkspaceModuleReader, path: string): boolean {
  if (path.endsWith(".mjs")) return true;
  if (!path.endsWith(".js")) return false;
  return nearestPackageType(reader, path) === "module";
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
  exports?: unknown;
  imports?: unknown;
}
