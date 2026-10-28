
import { constantsBuiltin } from "../builtins/constants.ts";
import { EventEmitter } from "../builtins/events.ts";
import { normalize } from "../builtins/path.ts";
import { Readable, Writable } from "../builtins/stream.ts";

import type { WorkspaceModuleReader } from "../modules/index.ts";
import type { RuntimeFsBinding, RuntimeFsData } from "../types.ts";
import type { CliEvaluationFsWriteResult } from "./cli-evaluator.ts";


export function bindCliFsStream<T extends Record<string, unknown>>(target: T, stream: Readable | Writable): T {
  Object.assign(target, stream);
  let prototype = Object.getPrototypeOf(stream) as object | null;
  while (prototype && prototype !== Object.prototype) {
    for (const name of Object.getOwnPropertyNames(prototype)) {
      if (name === "constructor" || Object.hasOwn(target, name)) continue;
      const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
      if (typeof descriptor?.value === "function") {
        Object.defineProperty(target, name, {
          configurable: true,
          value: descriptor.value.bind(stream),
          writable: true
        });
      } else if (descriptor?.get || descriptor?.set) {
        Object.defineProperty(target, name, {
          configurable: true,
          ...(descriptor.get ? { get: descriptor.get.bind(stream) } : {}),
          ...(descriptor.set ? { set: descriptor.set.bind(stream) } : {})
        });
      }
    }
    prototype = Object.getPrototypeOf(prototype) as object | null;
  }
  return target;
}

export function createFileHandle(fh: number, fs: CliFileHandleFs): CliFileHandle {
  return {
    fd: fh,
    async chmod(mode: number): Promise<void> {
      fs.fchmodSync(fh, mode);
    },
    async chown(uid: number, gid: number): Promise<void> {
      fs.fchownSync(fh, uid, gid);
    },
    async close(): Promise<void> {
      fs.closeSync(fh);
    },
    async read(
      buffer: Uint8Array,
      offset = 0,
      length = buffer.byteLength - offset,
      position: number | null = 0
    ): Promise<{ bytesRead: number; buffer: Uint8Array }> {
      const start = position ?? 0;
      const bytes = (fs.readSync(fh) as Uint8Array).slice(start, start + length);
      buffer.set(bytes, offset);
      return { bytesRead: bytes.byteLength, buffer };
    },
    async sync(): Promise<void> {
      fs.fsyncSync(fh);
    },
    async write(data: RuntimeFsData): Promise<{ bytesWritten: number; buffer: RuntimeFsData }> {
      const bytesWritten = fs.writeSync(fh, data);
      return { bytesWritten, buffer: data };
    }
  };
}

export function callWithFsCallback<T>(read: () => T, callback: (error: Error | null, value?: T) => void): void {
  queueMicrotask(() => {
    let value: T;
    try {
      value = read();
    } catch (error) {
      callback(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    callback(null, value);
  });
}

export function callWithOptionalFsCallback(run: () => void, callback: (error?: Error | null) => void): void {
  queueMicrotask(() => {
    try {
      run();
    } catch (error) {
      callback(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    callback(null);
  });
}

export type CliFsRealpath = ((path: string, callback: (error: Error | null, resolvedPath?: string) => void) => void) & {
  native?: CliFsRealpath;
};
export type CliFsRealpathSync = ((path: string) => string) & { native?: CliFsRealpathSync };

export interface CliOpenFile {
  bytes: Uint8Array;
  path: string;
  position: number;
  writable: boolean;
}

export interface CliOpenMode {
  truncate: boolean;
  writable: boolean;
}

export interface CliWriteOptions {
  encoding?: string;
  length?: number;
  offset?: number;
  position?: number;
}

export interface CliCreateReadStreamOptions {
  encoding?: "utf8" | "utf-8" | null;
}

export interface CliCreateWriteStreamOptions {
  flags?: string;
}

export interface CliFileHandle {
  fd: number;
  chmod(mode: number): Promise<void>;
  chown(uid: number, gid: number): Promise<void>;
  close(): Promise<void>;
  read(
    buffer: Uint8Array,
    offset?: number,
    length?: number,
    position?: number | null
  ): Promise<{ bytesRead: number; buffer: Uint8Array }>;
  sync(): Promise<void>;
  write(data: RuntimeFsData): Promise<{ bytesWritten: number; buffer: RuntimeFsData }>;
}

export interface CliFileHandleFs {
  closeSync(fd: number): void;
  fchmodSync(fd: number, mode: number): void;
  fchownSync(fd: number, uid: number, gid: number): void;
  fsyncSync(fd: number): void;
  readSync(fd: number, buffer?: Uint8Array, offset?: number, length?: number, position?: number | null): Uint8Array | number;
  writeSync(fd: number, data: RuntimeFsData): number;
}


export interface CliRmOptions {
  force?: boolean;
  recursive?: boolean;
}

export interface CliCpOptions {
  force?: boolean;
  recursive?: boolean;
}

export interface CliReaddirOptions {
  withFileTypes?: boolean;
}

export interface CliStatOptions {
  throwIfNoEntry?: boolean;
}

export interface CliDirent {
  name: string;
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

export interface CliDir extends AsyncIterable<CliDirent> {
  path: string;
  close(): Promise<void>;
  closeSync(): void;
  read(): Promise<CliDirent | null>;
  readSync(): CliDirent | null;
}

export type CliWatchEventType = "change" | "rename";
export type CliWatchListener = (eventType: CliWatchEventType, filename: string) => void;
export type CliFsStat = ReturnType<RuntimeFsBinding["statSync"]>;
export type CliFsStatListener = (current: CliFsStat | undefined, previous: CliFsStat | undefined) => void;

export interface CliFsDebugBinding {
  __debugWatchSummary?: () => CliEvaluationFsWriteResult;
}

export function getCliFsWatchSummary(fs: RuntimeFsBinding): CliEvaluationFsWriteResult {
  return (fs as RuntimeFsBinding & CliFsDebugBinding).__debugWatchSummary?.() ?? {
    statWatcherCount: 0,
    watcherCount: 0,
    watchedPaths: []
  };
}

export interface CliWatchOptions {
  persistent?: boolean;
  recursive?: boolean;
}

export interface CliWatchFileOptions {
  bigint?: boolean;
  interval?: number;
  persistent?: boolean;
}

export type CliFsWatcher = EventEmitter & {
  closed: boolean;
  close(): void;
  listener?: CliWatchListener;
  path: string;
  ref(): CliFsWatcher;
  unref(): CliFsWatcher;
};

export type CliFsStatWatcher = EventEmitter & {
  closed: boolean;
  close(): void;
  listener: CliFsStatListener;
  path: string;
  previous: CliFsStat | undefined;
  ref(): CliFsStatWatcher;
  unref(): CliFsStatWatcher;
};


export function createCliFsWatcher(path: string, listener?: CliWatchListener): CliFsWatcher {
  const watcher = new EventEmitter() as CliFsWatcher;
  watcher.closed = false;
  if (listener) watcher.listener = listener;
  watcher.path = path;
  watcher.close = () => {
    if (watcher.closed) return;
    watcher.closed = true;
    watcher.emit("close");
  };
  watcher.ref = () => watcher;
  watcher.unref = () => watcher;
  return watcher;
}

export function createCliFsStatWatcher(path: string, listener: CliFsStatListener): CliFsStatWatcher {
  const watcher = new EventEmitter() as CliFsStatWatcher;
  watcher.closed = false;
  watcher.listener = listener;
  watcher.path = path;
  watcher.previous = undefined;
  watcher.close = () => {
    if (watcher.closed) return;
    watcher.closed = true;
    watcher.emit("close");
  };
  watcher.ref = () => watcher;
  watcher.unref = () => watcher;
  return watcher;
}

export function createCliDir(path: string, entries: CliDirent[]): CliDir {
  let index = 0;
  let closed = false;
  const dir: CliDir = {
    path,
    async close(): Promise<void> {
      dir.closeSync();
    },
    closeSync(): void {
      closed = true;
    },
    async read(): Promise<CliDirent | null> {
      return dir.readSync();
    },
    readSync(): CliDirent | null {
      if (closed) throw createFsError("ERR_DIR_CLOSED", `Directory handle was closed: ${path}`);
      return entries[index++] || null;
    },
    async *[Symbol.asyncIterator](): AsyncIterator<CliDirent> {
      let entry: CliDirent | null;
      while ((entry = dir.readSync())) yield entry;
    }
  };
  return dir;
}

export function watchesPath(watchPath: string, changedPath: string): boolean {
  return watchPath === changedPath || changedPath.startsWith(`${watchPath}/`);
}

export function basenameOf(path: string): string {
  const normalized = normalize(path);
  const index = normalized.lastIndexOf("/");
  return index === -1 ? normalized : normalized.slice(index + 1);
}

export function statFromReader(reader: WorkspaceModuleReader, path: string): ReturnType<RuntimeFsBinding["statSync"]> {
  const time = new Date(0);
  try {
    const size = readWorkspaceBytes(reader, normalize(path), new TextEncoder()).byteLength;
    return {
      atime: time,
      atimeMs: time.getTime(),
      birthtime: time,
      birthtimeMs: time.getTime(),
      blksize: 4096,
      blocks: Math.ceil(size / 512),
      ctime: time,
      ctimeMs: time.getTime(),
      dev: 0,
      gid: 0,
      ino: hashInode(normalize(path)),
      mode: 0o100644,
      mtime: time,
      mtimeMs: time.getTime(),
      nlink: 1,
      rdev: 0,
      size,
      uid: 0,
      isFile: () => true,
      isDirectory: () => false,
      isSymbolicLink: () => false
    };
  } catch {
    reader.listDir(normalize(path));
    return {
      atime: time,
      atimeMs: time.getTime(),
      birthtime: time,
      birthtimeMs: time.getTime(),
      blksize: 4096,
      blocks: 0,
      ctime: time,
      ctimeMs: time.getTime(),
      dev: 0,
      gid: 0,
      ino: hashInode(normalize(path)),
      mode: 0o040755,
      mtime: time,
      mtimeMs: time.getTime(),
      nlink: 1,
      rdev: 0,
      size: 0,
      uid: 0,
      isFile: () => false,
      isDirectory: () => true,
      isSymbolicLink: () => false
    };
  }
}

export function hashInode(path: string): number {
  let hash = 2166136261;
  for (let index = 0; index < path.length; index += 1) {
    hash ^= path.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function unsupportedFsMutation(method: string): Error {
  return createFsError("ERR_BROWSER_FS_MUTATION_UNSUPPORTED", `fs.${method} is not supported by CLI module evaluator`);
}

export function createDirent(name: string, path: string, reader: WorkspaceModuleReader): CliDirent {
  const stats = statFromReader(reader, path);
  return {
    name,
    isDirectory: () => stats.isDirectory(),
    isFile: () => stats.isFile(),
    isSymbolicLink: () => false
  };
}

export function createFsError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

export function openMode(flags: string | number): CliOpenMode {
  if (typeof flags === "number") {
    return {
      truncate: (flags & constantsBuiltin.O_TRUNC) === constantsBuiltin.O_TRUNC,
      writable: (flags & constantsBuiltin.O_WRONLY) === constantsBuiltin.O_WRONLY
        || (flags & constantsBuiltin.O_RDWR) === constantsBuiltin.O_RDWR
        || (flags & constantsBuiltin.O_CREAT) === constantsBuiltin.O_CREAT
        || (flags & constantsBuiltin.O_APPEND) === constantsBuiltin.O_APPEND
    };
  }
  return {
    truncate: flags.startsWith("w"),
    writable: flags.includes("w") || flags.includes("a") || flags.includes("+")
  };
}

export function initialOpenBytes(reader: WorkspaceModuleReader, path: string, mode: CliOpenMode, encoder: TextEncoder): Uint8Array {
  if (mode.truncate) return new Uint8Array();
  try {
    return readWorkspaceBytes(reader, path, encoder);
  } catch (error) {
    if (mode.writable) return new Uint8Array();
    throw error;
  }
}

export function readWorkspaceBytes(reader: WorkspaceModuleReader, path: string, encoder: TextEncoder): Uint8Array {
  const maybeReader = reader as WorkspaceModuleReader & { readBytes?: (path: string) => Uint8Array };
  if (maybeReader.readBytes) return maybeReader.readBytes(path);
  return encoder.encode(reader.readText(path));
}

export function resolveSymlinkTarget(target: string, linkPath: string): string {
  if (target.startsWith("/")) return normalize(target);
  return normalize(`${dirnameOf(linkPath)}/${target}`);
}

export function dirnameOf(path: string): string {
  const normalized = normalize(path);
  const index = normalized.lastIndexOf("/");
  return index <= 0 ? "/" : normalized.slice(0, index);
}
