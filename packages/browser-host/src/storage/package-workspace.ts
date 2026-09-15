import type { JsonValue, OpfsLike } from "./types.ts";
import { createMemoryOpfs } from "./opfs.ts";

export interface OpfsPackageWorkspaceOptions {
  opfs?: OpfsLike;
  root?: string;
}

export class OpfsPackageWorkspace {
  readonly opfs: OpfsLike;
  readonly root: string;

  constructor(options: OpfsPackageWorkspaceOptions = {}) {
    this.opfs = options.opfs || createMemoryOpfs();
    this.root = trimSlashes(options.root || "package-workspace");
    this.mkdir("/");
  }

  readText(path: string): string {
    const record = this.#readRecord(this.#resolvePath(path));
    if (!isTextFileRecord(record)) throw createWorkspaceError("EISDIR", `Not a text file: ${path}`);
    return record.data;
  }

  listDir(path: string): string[] {
    const normalized = this.#resolvePath(path);
    const record = this.#readRecord(normalized);
    if (!isDirectoryRecord(record)) throw createWorkspaceError("ENOTDIR", `Not a directory: ${normalized}`);

    const prefix = `${this.#key(normalized)}/`;
    const entries = new Set<string>();
    for (const key of this.opfs.listFiles(prefix)) {
      const relative = key.slice(prefix.length);
      if (relative) entries.add(firstPathSegment(relative));
    }
    return [...entries].sort();
  }

  readlink(path: string): string {
    const normalized = normalizePath(path);
    const record = this.opfs.readFile(this.#key(normalized));
    if (!isSymlinkRecord(record)) {
      if (!isWorkspaceRecord(record)) throw createWorkspaceError("ENOENT", `No such file or directory: ${normalized}`);
      throw createWorkspaceError("EINVAL", `Not a symbolic link: ${normalized}`);
    }
    return record.target;
  }

  mkdir(path: string): void {
    this.#writeRecord(path, { kind: "directory" });
  }

  writeText(path: string, data: string): void {
    const normalized = normalizePath(path);
    this.#ensureParent(normalized);
    this.#writeRecord(normalized, { kind: "text", data });
  }

  copyFile(source: string, target: string): void {
    this.writeText(target, this.readText(source));
  }

  copyDirectory(source: string, target: string): void {
    const normalizedSource = normalizePath(source);
    const normalizedTarget = normalizePath(target);
    const sourceRecord = this.#readRecord(normalizedSource);
    if (isSymlinkRecord(sourceRecord)) {
      this.copyDirectory(sourceRecord.target, normalizedTarget);
      return;
    }
    if (!isDirectoryRecord(sourceRecord)) throw createWorkspaceError("ENOTDIR", `Not a directory: ${normalizedSource}`);

    this.mkdir(normalizedTarget);
    const sourcePrefix = `${this.#key(normalizedSource)}/`;
    for (const sourceKey of this.opfs.listFiles(sourcePrefix)) {
      const relative = sourceKey.slice(sourcePrefix.length);
      const record = this.opfs.readFile(sourceKey);
      if (!relative || !isWorkspaceRecord(record)) continue;
      this.#writeRecord(`${normalizedTarget}/${relative}`, record);
    }
  }

  remove(path: string): void {
    const normalized = normalizePath(path);
    this.opfs.deleteFile(this.#key(normalized));
    const prefix = `${this.#key(normalized)}/`;
    for (const key of this.opfs.listFiles(prefix)) {
      this.opfs.deleteFile(key);
    }
  }

  rename(source: string, target: string): void {
    const normalizedSource = normalizePath(source);
    const normalizedTarget = normalizePath(target);
    this.remove(normalizedTarget);
    const sourceRecord = this.opfs.readFile(this.#key(normalizedSource));
    if (isWorkspaceRecord(sourceRecord)) {
      this.#ensureParent(normalizedTarget);
      this.#writeRecord(normalizedTarget, sourceRecord);
      this.remove(normalizedSource);
      return;
    }

    const sourcePrefix = `${this.#key(normalizedSource)}/`;
    let moved = false;
    this.mkdir(normalizedTarget);
    for (const sourceKey of this.opfs.listFiles(sourcePrefix)) {
      const relative = sourceKey.slice(sourcePrefix.length);
      const record = this.opfs.readFile(sourceKey);
      if (!relative || !isWorkspaceRecord(record)) continue;
      this.#writeRecord(`${normalizedTarget}/${relative}`, record);
      moved = true;
    }
    if (!moved) throw createWorkspaceError("ENOENT", `No such file or directory: ${normalizedSource}`);
    this.remove(normalizedSource);
  }

  symlink(target: string, path: string): void {
    const normalized = normalizePath(path);
    this.#ensureParent(normalized);
    this.#writeRecord(normalized, { kind: "symlink", target: normalizePath(target) });
  }

  exists(path: string): boolean {
    return this.opfs.readFile(this.#key(path)) !== null || this.opfs.readFile(this.#key(this.#resolvePath(path))) !== null;
  }

  #readRecord(path: string): WorkspaceRecord {
    const normalized = normalizePath(path);
    const record = this.opfs.readFile(this.#key(normalized));
    if (!isWorkspaceRecord(record)) throw createWorkspaceError("ENOENT", `No such workspace entry: ${normalized}`);
    return record;
  }

  #writeRecord(path: string, record: WorkspaceRecord): void {
    this.opfs.writeFile(this.#key(path), record);
  }

  #ensureParent(path: string): void {
    const parent = dirname(path);
    if (this.exists(parent)) return;
    this.#ensureParent(parent);
    this.mkdir(parent);
  }

  #resolvePath(path: string): string {
    let normalized = normalizePath(path);
    for (let depth = 0; depth < 16; depth += 1) {
      const next = this.#resolveOneSymlink(normalized);
      if (next === normalized) return normalized;
      normalized = next;
    }
    throw createWorkspaceError("ELOOP", `Too many symbolic links: ${path}`);
  }

  #resolveOneSymlink(path: string): string {
    let bestLink: string | null = null;
    for (const key of this.opfs.listFiles(`${this.root}/`)) {
      const relative = key.slice(this.root.length + 1);
      const link = normalizePath(relative);
      if (path !== link && !path.startsWith(`${link}/`)) continue;
      const record = this.opfs.readFile(key);
      if (!isSymlinkRecord(record)) continue;
      if (!bestLink || link.length > bestLink.length) bestLink = link;
    }
    if (!bestLink) return path;
    const record = this.opfs.readFile(this.#key(bestLink));
    return isSymlinkRecord(record) ? normalizePath(`${record.target}${path.slice(bestLink.length)}`) : path;
  }

  #key(path: string): string {
    return `${this.root}/${normalizePath(path).slice(1)}`;
  }
}

type WorkspaceRecord = DirectoryRecord | TextFileRecord | SymlinkRecord;

interface DirectoryRecord {
  [key: string]: JsonValue;
  kind: "directory";
}

interface TextFileRecord {
  [key: string]: JsonValue;
  kind: "text";
  data: string;
}

interface SymlinkRecord {
  [key: string]: JsonValue;
  kind: "symlink";
  target: string;
}

export function createOpfsPackageWorkspace(options: OpfsPackageWorkspaceOptions = {}): OpfsPackageWorkspace {
  return new OpfsPackageWorkspace(options);
}

function isWorkspaceRecord(value: JsonValue | null): value is WorkspaceRecord {
  return isDirectoryRecord(value) || isTextFileRecord(value) || isSymlinkRecord(value);
}

function isDirectoryRecord(value: JsonValue | null): value is DirectoryRecord {
  return isRecord(value) && value.kind === "directory";
}

function isTextFileRecord(value: JsonValue | null): value is TextFileRecord {
  return isRecord(value) && value.kind === "text" && typeof value.data === "string";
}

function isSymlinkRecord(value: JsonValue | null): value is SymlinkRecord {
  return isRecord(value) && value.kind === "symlink" && typeof value.target === "string";
}

function isRecord(value: JsonValue | null): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizePath(path: string): string {
  const normalized = path.replaceAll("\\", "/").replace(/\/+/g, "/");
  if (normalized === "" || normalized === ".") return "/";
  const absolute = normalized.startsWith("/") ? normalized : `/${normalized}`;
  return absolute.endsWith("/") && absolute !== "/" ? absolute.slice(0, -1) : absolute;
}

function dirname(path: string): string {
  const normalized = normalizePath(path);
  const index = normalized.lastIndexOf("/");
  if (index <= 0) return "/";
  return normalized.slice(0, index);
}

function firstPathSegment(path: string): string {
  const index = path.indexOf("/");
  return index === -1 ? path : path.slice(0, index);
}

function trimSlashes(path: string): string {
  const trimmed = path.replace(/^\/+|\/+$/g, "");
  return trimmed || "package-workspace";
}

function createWorkspaceError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}
