import {
  NuriteoServices,
  SdkError,
  type NuriteoServicesOptions,
  type NuriteoFileEntry,
  type NuriteoFileWatchEvent,
  type NuriteoPreviewEvent,
  type NuriteoProcessHandle
} from "./services.ts";

export type NuriteoCoepMode = "require-corp" | "credentialless" | "none";

export interface NuriteoWebContainerOptions {
  coep?: NuriteoCoepMode;
  lifecycle?: NuriteoWebContainerLifecycle;
  services?: NuriteoServices | NuriteoServicesOptions;
  workdirName?: string;
}

export interface NuriteoWebContainerLifecycle {
  boot(): Promise<unknown>;
  teardown(): Promise<void>;
}

export interface NuriteoFileSystemTree {
  [name: string]: NuriteoFileSystemTreeNode;
}

export type NuriteoFileSystemTreeNode =
  | { file: { contents: string | Uint8Array } }
  | { directory: NuriteoFileSystemTree }
  | { symlink: string };

export interface NuriteoMountSnapshot {
  schemaVersion: 1;
  format: "nuriteo-mount";
  files: Array<{ path: string; contents: string }>;
}

export type NuriteoWebContainerEventName = "port" | "server-ready" | "server-close";

export interface NuriteoSpawnOptions {
  cwd?: string;
  env?: Record<string, string>;
}

export class NuriteoWebContainer {
  readonly coep: NuriteoCoepMode;
  readonly workdir: string;
  readonly services: NuriteoServices;
  readonly fs: NuriteoWebContainerFileSystem;
  readonly lifecycle: NuriteoWebContainerLifecycle | undefined;
  #booted = false;
  #previewUnsubscribe: (() => void) | null = null;
  #listeners = new Map<NuriteoWebContainerEventName, Set<(event: NuriteoPreviewEvent) => void>>();

  constructor(options: NuriteoWebContainerOptions = {}) {
    this.coep = options.coep || "require-corp";
    this.workdir = `/${normalizeSegment(options.workdirName || "workspace")}`;
    this.lifecycle = options.lifecycle;
    this.services = options.services instanceof NuriteoServices
      ? options.services
      : new NuriteoServices(options.services);
    this.fs = new NuriteoWebContainerFileSystem(this.services);
  }

  async boot(): Promise<this> {
    if (this.#booted) return this;
    try {
      await this.lifecycle?.boot();
      if (!this.#previewUnsubscribe) {
        this.#previewUnsubscribe = this.services.preview.subscribe((event) => this.#emit(event));
      }
      this.#booted = true;
    } catch (error) {
      if (error instanceof SdkError && error.code === "ESDK_ADAPTER_MISSING") {
        // Preview events remain optional when no preview adapter is attached.
        this.#booted = true;
        return this;
      }
      try { await this.lifecycle?.teardown(); } catch { /* preserve the boot failure */ }
      throw new SdkError("ESDK_LIFECYCLE_FAILED", "WebContainer boot failed", error);
    }
    return this;
  }

  async mount(input: NuriteoFileSystemTree | NuriteoMountSnapshot, options: { mountPoint?: string } = {}): Promise<void> {
    const root = normalizePath(options.mountPoint || this.workdir);
    if (isSnapshot(input)) {
      for (const file of input.files) {
        if (!file || typeof file.path !== "string" || typeof file.contents !== "string") {
          throw new SdkError("ESDK_INVALID_ARGUMENT", "Cargo mount snapshot files require string path and contents");
        }
        await this.fs.writeFile(joinMountPath(root, file.path), file.contents, { createParents: true });
      }
      return;
    }
    if (isSnapshotLike(input)) {
      throw new SdkError("ESDK_INVALID_ARGUMENT", "Unsupported Cargo mount snapshot schema or format");
    }
    await mountTree(this.fs, root, input);
  }

  async spawn(command: string, args: string[] = [], options: NuriteoSpawnOptions = {}): Promise<NuriteoProcessHandle> {
    return this.services.processes.spawn({
      command,
      args: [...args],
      cwd: options.cwd || this.workdir,
      ...(options.env ? { env: { ...options.env } } : {})
    });
  }

  setPreviewScript(script: string | null): Promise<void> {
    return this.services.preview.setPreviewScript(script);
  }

  on(event: NuriteoWebContainerEventName, listener: (event: NuriteoPreviewEvent) => void): () => void {
    const listeners = this.#listeners.get(event) || new Set();
    listeners.add(listener);
    this.#listeners.set(event, listeners);
    return () => listeners.delete(listener);
  }

  async teardown(): Promise<void> {
    if (!this.#booted && !this.#previewUnsubscribe) return;
    this.#booted = false;
    this.#previewUnsubscribe?.();
    this.#previewUnsubscribe = null;
    this.#listeners.clear();
    await this.lifecycle?.teardown();
  }

  #emit(event: NuriteoPreviewEvent): void {
    for (const listener of this.#listeners.get(event.type) || []) listener({ ...event });
  }
}

export class NuriteoWebContainerFileSystem {
  private readonly services: NuriteoServices;

  constructor(services: NuriteoServices) {
    this.services = services;
  }

  readFile(path: string): Promise<Uint8Array | string> {
    return this.services.fs.readFile(normalizePath(path));
  }

  async writeFile(path: string, data: Uint8Array | string, options: { createParents?: boolean } = {}): Promise<void> {
    const normalized = normalizePath(path);
    if (options.createParents) await this.services.fs.mkdir(parent(normalized), { recursive: true });
    await this.services.fs.writeFile(normalized, data);
  }

  readdir(path: string): Promise<NuriteoFileEntry[]> {
    return this.services.fs.readdir(normalizePath(path));
  }

  mkdir(path: string, options: { recursive?: boolean } = {}): Promise<void> {
    return this.services.fs.mkdir(normalizePath(path), options);
  }

  rm(path: string, options: { force?: boolean; recursive?: boolean } = {}): Promise<void> {
    return this.services.fs.rm(normalizePath(path), options);
  }

  watch(path: string, listener: (event: NuriteoFileWatchEvent) => void): () => void {
    return this.services.fs.watch(normalizePath(path), listener);
  }
}

export function createNuriteoWebContainer(options: NuriteoWebContainerOptions = {}): NuriteoWebContainer {
  return new NuriteoWebContainer(options);
}

export function createNuriteoMountSnapshot(files: Record<string, string>): NuriteoMountSnapshot {
  return {
    schemaVersion: 1,
    format: "nuriteo-mount",
    files: Object.entries(files)
      .map(([path, contents]) => ({ path: normalizePath(path).replace(/^\/+/, ""), contents }))
      .sort((left, right) => left.path.localeCompare(right.path))
  };
}

async function mountTree(fs: NuriteoWebContainerFileSystem, root: string, tree: NuriteoFileSystemTree): Promise<void> {
  await fs.mkdir(root, { recursive: true });
  for (const [name, node] of Object.entries(tree)) {
    if (!node || typeof node !== "object") {
      throw new SdkError("ESDK_INVALID_ARGUMENT", `Invalid filesystem tree node: ${name}`);
    }
    const path = join(root, normalizeSegment(name));
    if ("file" in node) await fs.writeFile(path, node.file.contents, { createParents: true });
    else if ("directory" in node) await mountTree(fs, path, node.directory);
    else throw new SdkError("ESDK_SYMLINK_UNSUPPORTED", `Symlink mount is not supported: ${path} -> ${node.symlink}`);
  }
}

function isSnapshot(value: NuriteoFileSystemTree | NuriteoMountSnapshot): value is NuriteoMountSnapshot {
  return "schemaVersion" in value
    && value.schemaVersion === 1
    && "format" in value
    && value.format === "nuriteo-mount"
    && "files" in value
    && Array.isArray(value.files);
}

function isSnapshotLike(value: NuriteoFileSystemTree | NuriteoMountSnapshot): boolean {
  return "schemaVersion" in value || "format" in value || "files" in value;
}

function normalizeSegment(value: string): string {
  const normalized = value.replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
  if (!normalized || normalized.includes("/") || normalized === "." || normalized === "..") {
    throw new SdkError("ESDK_PATH_INVALID", `Invalid path segment: ${value}`);
  }
  return normalized;
}

function normalizePath(value: string): string {
  const parts: string[] = [];
  for (const part of value.replaceAll("\\", "/").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) throw new SdkError("ESDK_PATH_INVALID", `Path escapes root: ${value}`);
      parts.pop();
    } else parts.push(part);
  }
  return `/${parts.join("/")}`;
}

function join(root: string, path: string): string {
  return normalizePath(`${root}/${path}`);
}

function joinMountPath(root: string, relativePath: string): string {
  if (relativePath.startsWith("/") || relativePath.replaceAll("\\", "/").split("/").includes("..")) {
    throw new SdkError("ESDK_PATH_INVALID", `Mount path escapes root: ${relativePath}`);
  }
  const target = join(root, relativePath);
  if (target !== root && !target.startsWith(`${root}/`)) {
    throw new SdkError("ESDK_PATH_INVALID", `Mount path escapes root: ${relativePath}`);
  }
  return target;
}

function parent(path: string): string {
  const index = path.lastIndexOf("/");
  return index <= 0 ? "/" : path.slice(0, index);
}
