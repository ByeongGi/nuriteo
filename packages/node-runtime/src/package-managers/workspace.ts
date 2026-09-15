import { join } from "../builtins/path.ts";

export type PackageManagerLinkStrategy = "symlink" | "copy-fallback";

export interface PackageManagerWorkspaceReader {
  readText(path: string): string;
  listDir(path: string): string[];
  readlink?(path: string): string;
}

export interface PackageManagerWorkspaceWriter {
  copyDirectory(source: string, target: string): void;
  copyFile(source: string, target: string): void;
  mkdir(path: string): void;
  remove(path: string): void;
  rename?(source: string, target: string): void;
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
    const normalized = this.resolvePath(path);
    const data = this.files.get(normalized);
    if (data === undefined) throw createWorkspaceError("ENOENT", `No such file: ${normalized}`);
    return data;
  }

  listDir(path: string): string[] {
    const normalized = this.resolvePath(path);
    const prefix = normalized === "/" ? "/" : `${normalized}/`;
    const entries = new Set<string>();
    for (const directory of this.directories) {
      if (directory === normalized || !directory.startsWith(prefix)) continue;
      entries.add(firstPathSegment(directory.slice(prefix.length)));
    }
    for (const link of this.links.keys()) {
      if (!link.startsWith(prefix)) continue;
      entries.add(firstPathSegment(link.slice(prefix.length)));
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

  readlink(path: string): string {
    const normalized = normalizePath(path);
    const target = this.links.get(normalized);
    if (!target) {
      if (!this.files.has(normalized) && !this.directories.has(normalized)) {
        throw createWorkspaceError("ENOENT", `No such file or directory: ${normalized}`);
      }
      throw createWorkspaceError("EINVAL", `Not a symbolic link: ${normalized}`);
    }
    return target;
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

  remove(path: string): void {
    const normalized = normalizePath(path);
    this.files.delete(normalized);
    this.links.delete(normalized);
    const prefix = `${normalized}/`;
    for (const file of [...this.files.keys()]) {
      if (file.startsWith(prefix)) this.files.delete(file);
    }
    for (const link of [...this.links.keys()]) {
      if (link.startsWith(prefix)) this.links.delete(link);
    }
    for (const directory of [...this.directories]) {
      if (directory !== "/" && (directory === normalized || directory.startsWith(prefix))) {
        this.directories.delete(directory);
      }
    }
  }

  rename(source: string, target: string): void {
    const normalizedSource = normalizePath(source);
    const normalizedTarget = normalizePath(target);
    this.remove(normalizedTarget);
    const file = this.files.get(normalizedSource);
    if (file !== undefined) {
      this.writeText(normalizedTarget, file);
      this.remove(normalizedSource);
      return;
    }
    const link = this.links.get(normalizedSource);
    if (link !== undefined) {
      this.symlink(link, normalizedTarget);
      this.remove(normalizedSource);
      return;
    }
    if (!this.directories.has(normalizedSource)) {
      throw createWorkspaceError("ENOENT", `No such file or directory: ${normalizedSource}`);
    }

    const prefix = `${normalizedSource}/`;
    this.mkdir(normalizedTarget);
    for (const directory of [...this.directories]) {
      if (directory.startsWith(prefix)) this.mkdir(join(normalizedTarget, directory.slice(prefix.length)));
    }
    for (const [path, data] of [...this.files]) {
      if (path.startsWith(prefix)) this.writeText(join(normalizedTarget, path.slice(prefix.length)), data);
    }
    for (const [path, linkTarget] of [...this.links]) {
      if (path.startsWith(prefix)) this.symlink(linkTarget, join(normalizedTarget, path.slice(prefix.length)));
    }
    this.remove(normalizedSource);
  }

  symlink(target: string, path: string): void {
    const normalized = normalizePath(path);
    ensureDirectory(this.directories, dirname(normalized));
    this.links.set(normalized, normalizePath(target));
  }

  exists(path: string): boolean {
    const normalized = normalizePath(path);
    if (this.files.has(normalized) || this.directories.has(normalized) || this.links.has(normalized)) return true;
    const resolved = this.resolvePath(normalized);
    return this.files.has(resolved) || this.directories.has(resolved) || this.links.has(resolved);
  }

  private resolvePath(path: string): string {
    let normalized = normalizePath(path);
    for (let depth = 0; depth < 16; depth += 1) {
      const next = resolveOneSymlink(this.links, normalized);
      if (next === normalized) return normalized;
      normalized = next;
    }
    throw createWorkspaceError("ELOOP", `Too many symbolic links: ${path}`);
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

function resolveOneSymlink(links: Map<string, string>, path: string): string {
  let bestLink: string | null = null;
  for (const link of links.keys()) {
    if (path !== link && !path.startsWith(`${link}/`)) continue;
    if (!bestLink || link.length > bestLink.length) bestLink = link;
  }
  if (!bestLink) return path;
  const target = links.get(bestLink);
  if (!target) return path;
  return normalizePath(`${target}${path.slice(bestLink.length)}`);
}

function createWorkspaceError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}
