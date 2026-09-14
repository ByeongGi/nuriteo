import { join } from "../builtins/path.ts";

export type PackageManagerLinkStrategy = "symlink" | "copy-fallback";

export interface PackageManagerWorkspaceReader {
  readText(path: string): string;
  listDir(path: string): string[];
}

export interface PackageManagerWorkspaceWriter {
  copyDirectory(source: string, target: string): void;
  copyFile(source: string, target: string): void;
  mkdir(path: string): void;
  symlink?(target: string, path: string): void;
  writeText(path: string, data: string): void;
}

export interface PackageManagerWorkspace extends PackageManagerWorkspaceReader, PackageManagerWorkspaceWriter {}

export interface PackageManagerWorkspaceMount {
  path: string;
  data: string;
}

export class MemoryPackageManagerWorkspace implements PackageManagerWorkspace {
  readonly files = new Map<string, string>();
  readonly directories = new Set<string>(["/"]);
  readonly links = new Map<string, string>();

  constructor(mounts: PackageManagerWorkspaceMount[] = []) {
    for (const mount of mounts) this.writeText(mount.path, mount.data);
  }

  readText(path: string): string {
    const normalized = normalizePath(path);
    const data = this.files.get(normalized);
    if (data === undefined) throw createWorkspaceError("ENOENT", `No such file: ${normalized}`);
    return data;
  }

  listDir(path: string): string[] {
    const normalized = normalizePath(path);
    const prefix = normalized === "/" ? "/" : `${normalized}/`;
    const entries = new Set<string>();
    for (const directory of this.directories) {
      if (directory === normalized || !directory.startsWith(prefix)) continue;
      entries.add(firstPathSegment(directory.slice(prefix.length)));
    }
    for (const file of this.files.keys()) {
      if (!file.startsWith(prefix)) continue;
      entries.add(firstPathSegment(file.slice(prefix.length)));
    }
    if (entries.size === 0 && !this.directories.has(normalized)) {
      throw createWorkspaceError("ENOENT", `No such directory: ${normalized}`);
    }
    return [...entries].sort();
  }

  mkdir(path: string): void {
    ensureDirectory(this.directories, normalizePath(path));
  }

  writeText(path: string, data: string): void {
    const normalized = normalizePath(path);
    ensureDirectory(this.directories, dirname(normalized));
    this.files.set(normalized, data);
    this.links.delete(normalized);
  }

  copyFile(source: string, target: string): void {
    this.writeText(target, this.readText(source));
  }

  copyDirectory(source: string, target: string): void {
    const normalizedSource = normalizePath(source);
    const normalizedTarget = normalizePath(target);
    const prefix = `${normalizedSource}/`;
    if (!this.directories.has(normalizedSource)) {
      throw createWorkspaceError("ENOENT", `No such directory: ${normalizedSource}`);
    }
    this.mkdir(normalizedTarget);
    for (const directory of this.directories) {
      if (!directory.startsWith(prefix)) continue;
      this.mkdir(join(normalizedTarget, directory.slice(prefix.length)));
    }
    for (const [file, data] of this.files) {
      if (!file.startsWith(prefix)) continue;
      this.writeText(join(normalizedTarget, file.slice(prefix.length)), data);
    }
  }

  symlink(target: string, path: string): void {
    const normalized = normalizePath(path);
    ensureDirectory(this.directories, dirname(normalized));
    this.links.set(normalized, normalizePath(target));
  }

  exists(path: string): boolean {
    const normalized = normalizePath(path);
    return this.files.has(normalized) || this.directories.has(normalized) || this.links.has(normalized);
  }
}

function ensureDirectory(directories: Set<string>, path: string): void {
  const normalized = normalizePath(path);
  if (directories.has(normalized)) return;
  ensureDirectory(directories, dirname(normalized));
  directories.add(normalized);
}

function normalizePath(path: string): string {
  const normalized = path.replaceAll("\\", "/").replace(/\/+/g, "/");
  if (normalized === "") return "/";
  if (normalized === "/") return "/";
  return normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
}

function dirname(path: string): string {
  const index = path.lastIndexOf("/");
  if (index <= 0) return "/";
  return path.slice(0, index);
}

function firstPathSegment(path: string): string {
  const index = path.indexOf("/");
  return index === -1 ? path : path.slice(0, index);
}

function createWorkspaceError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}
