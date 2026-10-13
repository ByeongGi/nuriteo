import { join } from "../builtins/path.ts";
import type { WorkspaceModuleReader } from "../modules/index.ts";
import type { PackageManagerWorkspaceMount } from "../package-managers/workspace.ts";
import type { ViteDependencyMaterializationPlan } from "./vite-materialization.ts";

export interface ViteProductPackageArtifact {
  mounts: PackageManagerWorkspaceMount[];
  version: string;
}

export interface ViteProductDependencyArtifact {
  mounts: PackageManagerWorkspaceMount[];
  name: string;
  version?: string;
}

export interface ViteProductPackageArtifactFromWorkspaceOptions {
  packageRoot: string;
  reader: WorkspaceModuleReader;
  version?: string;
}

export interface ViteProductDependencyArtifactFromWorkspaceOptions {
  name?: string;
  packageRoot: string;
  reader: WorkspaceModuleReader;
  version?: string;
}

export interface ViteProductDependencyArtifactsFromWorkspaceOptions {
  names: string[];
  nodeModulesRoot: string;
  reader: WorkspaceModuleReader;
  skipMissing?: boolean;
}

export interface ViteProductDependencyArtifactsFromPlanOptions {
  nodeModulesRoot: string;
  plan: ViteDependencyMaterializationPlan;
  reader: WorkspaceModuleReader;
  skipMissing?: boolean;
}

export interface ViteProductDependencyArtifactMergeResult {
  artifacts: ViteProductDependencyArtifact[];
  replaced: string[];
}


export type ViteProductPackageArtifactErrorCode = "EVITEARTIFACTMANIFEST" | "EVITEARTIFACTNAME" | "EVITEARTIFACTBIN";

export class ViteProductPackageArtifactError extends Error {
  code: ViteProductPackageArtifactErrorCode;
  path: string;

  constructor(code: ViteProductPackageArtifactErrorCode, message: string, path: string) {
    super(message);
    this.name = "ViteProductPackageArtifactError";
    this.code = code;
    this.path = path;
  }
}

export interface VitePackageManifest {
  bin?: string | Record<string, string>;
  dependencies?: Record<string, string>;
  name?: string;
  optionalDependencies?: Record<string, string>;
  version?: string;
}

export function createVitePackageArtifactFromWorkspace(options: ViteProductPackageArtifactFromWorkspaceOptions): ViteProductPackageArtifact {
  const packageRoot = normalizeServedPath(options.packageRoot).replace(/\/$/, "");
  const packageJson = JSON.parse(options.reader.readText(join(packageRoot, "package.json"))) as VitePackageManifest;
  if (packageJson.name !== "vite") {
    throw new ViteProductPackageArtifactError("EVITEARTIFACTNAME", "Mounted Vite package artifact package.json must have name \"vite\".", join(packageRoot, "package.json"));
  }
  const binPath = join(packageRoot, readVitePackageBinPath(packageJson));
  if (!readerExists(options.reader, binPath)) {
    throw new ViteProductPackageArtifactError("EVITEARTIFACTBIN", "Mounted Vite package artifact bin entry is missing.", binPath);
  }
  const mounts = collectTextMounts(options.reader, packageRoot);
  return {
    mounts,
    version: options.version || packageJson.version || "unknown"
  };
}

export function createViteDependencyArtifactFromWorkspace(options: ViteProductDependencyArtifactFromWorkspaceOptions): ViteProductDependencyArtifact {
  const packageRoot = normalizeServedPath(options.packageRoot).replace(/\/$/, "");
  const packageJsonPath = join(packageRoot, "package.json");
  const packageJson = JSON.parse(options.reader.readText(packageJsonPath)) as VitePackageManifest;
  const name = options.name || packageJson.name;
  if (!name) {
    throw new ViteProductPackageArtifactError("EVITEARTIFACTNAME", "Mounted dependency artifact package.json must have a package name.", packageJsonPath);
  }
  if (packageJson.name !== name && !isPackageAliasName(name, packageJson.name)) {
    throw new ViteProductPackageArtifactError("EVITEARTIFACTNAME", `Mounted dependency artifact package.json must have name "${name}".`, packageJsonPath);
  }
  return {
    name,
    mounts: collectTextMounts(options.reader, packageRoot),
    version: options.version || packageJson.version || "unknown"
  };
}

export function createViteDependencyArtifactsFromWorkspace(
  options: ViteProductDependencyArtifactsFromWorkspaceOptions
): ViteProductDependencyArtifact[] {
  const nodeModulesRoot = normalizeServedPath(options.nodeModulesRoot).replace(/\/$/, "");
  return uniquePackageNames(options.names).flatMap((name) => {
    const packageRoot = join(nodeModulesRoot, name);
    if (options.skipMissing && !readerExists(options.reader, join(packageRoot, "package.json"))) return [];
    return createViteDependencyArtifactFromWorkspace({
      name,
      packageRoot,
      reader: options.reader
    });
  });
}

export function createViteDependencyArtifactsFromPlan(
  options: ViteProductDependencyArtifactsFromPlanOptions
): ViteProductDependencyArtifact[] {
  return createViteDependencyArtifactsFromWorkspace({
    names: options.plan.missing.flatMap((item) => item.artifactNames),
    nodeModulesRoot: options.nodeModulesRoot,
    reader: options.reader,
    ...(options.skipMissing === undefined ? {} : { skipMissing: options.skipMissing })
  });
}

export function mergeViteDependencyArtifacts(
  ...artifactSets: Array<readonly ViteProductDependencyArtifact[]>
): ViteProductDependencyArtifactMergeResult {
  const artifactsByName = new Map<string, ViteProductDependencyArtifact>();
  const replaced = new Set<string>();
  for (const artifacts of artifactSets) {
    for (const artifact of artifacts) {
      if (artifactsByName.has(artifact.name)) replaced.add(artifact.name);
      artifactsByName.set(artifact.name, artifact);
    }
  }
  return {
    artifacts: [...artifactsByName.values()],
    replaced: [...replaced].sort()
  };
}


function collectTextMounts(reader: WorkspaceModuleReader, packageRoot: string): PackageManagerWorkspaceMount[] {
  const mounts: PackageManagerWorkspaceMount[] = [];
  for (const file of walkWorkspaceTextFiles(reader, packageRoot)) {
    const path = file.slice(packageRoot.length + 1);
    if (isBinaryPackageMount(path)) {
      mounts.push({
        path,
        data: encodeBase64(readWorkspaceBytes(reader, file)),
        encoding: "base64"
      });
    } else {
      mounts.push({
        path,
        data: reader.readText(file)
      });
    }
  }
  return mounts.sort((left, right) => left.path.localeCompare(right.path));
}

function* walkWorkspaceTextFiles(reader: WorkspaceModuleReader, path: string): Generator<string> {
  let entries: string[];
  try {
    entries = reader.listDir(path);
  } catch {
    try {
      reader.readText(path);
      yield path;
    } catch {
      // Ignore non-text entries in the mounted package artifact.
    }
    return;
  }
  for (const entry of entries) {
    yield* walkWorkspaceTextFiles(reader, join(path, entry));
  }
}

export function readerExists(reader: WorkspaceModuleReader, path: string): boolean {
  const maybeReader = reader as WorkspaceModuleReader & { exists?: (path: string) => boolean };
  if (maybeReader.exists?.(path) === true) return true;
  try {
    reader.readText(path);
    return true;
  } catch {
    try {
      reader.listDir(path);
      return true;
    } catch {
      return false;
    }
  }
}

function isBinaryPackageMount(path: string): boolean {
  return path.endsWith(".wasm");
}

function readWorkspaceBytes(reader: WorkspaceModuleReader, path: string): Uint8Array {
  const maybeReader = reader as WorkspaceModuleReader & { readBytes?: (path: string) => Uint8Array };
  if (maybeReader.readBytes) return maybeReader.readBytes(path);
  return new TextEncoder().encode(reader.readText(path));
}

function encodeBase64(bytes: Uint8Array): string {
  if (typeof btoa === "function") {
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  }
  const bufferCtor = (globalThis as typeof globalThis & { Buffer?: { from(value: Uint8Array): { toString(encoding: "base64"): string } } }).Buffer;
  if (bufferCtor) return bufferCtor.from(bytes).toString("base64");
  throw new Error("Base64 encoding is not available in this runtime");
}

export function decodeBase64(value: string): Uint8Array {
  if (typeof atob === "function") {
    return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
  }
  const bufferCtor = (globalThis as typeof globalThis & { Buffer?: { from(value: string, encoding: "base64"): Uint8Array } }).Buffer;
  if (bufferCtor) return new Uint8Array(bufferCtor.from(value, "base64"));
  throw new Error("Base64 decoding is not available in this runtime");
}

export function normalizePackageArtifactPath(path: string): string {
  return path.replace(/^\/+/, "");
}

export function readVitePackageBinPath(manifest: VitePackageManifest): string {
  if (typeof manifest.bin === "string") return manifest.bin;
  return manifest.bin?.vite || "bin/vite.js";
}


function normalizeServedPath(path: string): string {
  return path.startsWith("/") ? path : `/${path}`;
}

function uniquePackageNames(packages: string[]): string[] {
  return [...new Set(packages)];
}

function isPackageAliasName(aliasName: string, packageName: string | undefined): boolean {
  if (!packageName) return false;
  return aliasName.endsWith("-cjs") && aliasName.slice(0, -4) === packageName;
}
