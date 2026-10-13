import { Buffer as BrowserBuffer } from "../builtins/buffer.ts";
import { constantsBuiltin } from "../builtins/constants.ts";
import { EventEmitter } from "../builtins/events.ts";
import { isAbsolute, join, normalize } from "../builtins/path.ts";
import { Readable, Writable } from "../builtins/stream.ts";
import { fileURLToPath } from "../builtins/url.ts";
import type { WorkspaceModuleReader } from "../modules/index.ts";
import type { RuntimeFsBinding, RuntimeFsData } from "../types.ts";
import type { CliEvaluationFsTraceEntry, CliEvaluationFsWriteResult } from "./cli-evaluator.ts";
import type { PackageManagerWorkspaceWriter } from "./workspace.ts";

function fsTraceError(error: unknown): string {
  if (typeof error === "object" && error && "code" in error && typeof (error as { code?: unknown }).code === "string") {
    return (error as { code: string }).code;
  }
  return error instanceof Error ? error.message : String(error);
}

function normalizeFsPath(path: string | URL | { href?: string }, cwd: string): string {
  if (typeof path === "string") return normalize(isAbsolute(path) ? path : join(cwd, path));
  if (path instanceof URL) return normalize(fileURLToPath(path.href));
  if (typeof path.href === "string" && path.href.startsWith("file:")) return normalize(fileURLToPath(path.href));
  throw new TypeError("Path must be a string or file URL");
}

function decodeFsBytes(decoder: TextDecoder, value: ArrayBuffer | ArrayBufferView): string {
  const view = value instanceof ArrayBuffer
    ? new Uint8Array(value)
    : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  const shared = typeof SharedArrayBuffer === "function"
    && (view.buffer instanceof SharedArrayBuffer || Object.prototype.toString.call(view.buffer) === "[object SharedArrayBuffer]");
  if (!shared) return decoder.decode(view);
  const copy = new Uint8Array(view.byteLength);
  copy.set(view);
  return decoder.decode(copy);
}

export function createWorkspaceFsFacade(
  reader: WorkspaceModuleReader,
  writer?: PackageManagerWorkspaceWriter,
  getCwd: () => string = () => "/workspace",
  fsTrace?: CliEvaluationFsTraceEntry[]
): RuntimeFsBinding {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let nextFd = 3;
  const openFiles = new Map<number, CliOpenFile>();
  const watchers = new Set<CliFsWatcher>();
  const statWatchers = new Map<string, Set<CliFsStatWatcher>>();
  const modifiedTimes = new Map<string, number>();
  const initialModifiedTime = Date.now();
  let nextModifiedTime = initialModifiedTime + 1;
  const resolvePath = (path: string | URL | { href?: string }) => normalizeFsPath(path, getCwd());
  const traceFs = (entry: CliEvaluationFsTraceEntry) => {
    if (fsTrace && fsTrace.length < 1000) fsTrace.push(entry);
  };
  const realpath: CliFsRealpath = (path, callback) => {
    const normalized = resolvePath(path);
    traceFs({ op: "realpath", path: normalized, result: normalized });
    callback(null, normalized);
  };
  realpath.native = realpath;
  const realpathSync: CliFsRealpathSync = (path) => resolvePath(path);
  realpathSync.native = realpathSync;

  function readFileSync(path: string | URL): Uint8Array;
  function readFileSync(path: string | URL, encoding: "utf8" | "utf-8"): string;
  function readFileSync(path: string | URL, encoding?: "utf8" | "utf-8"): Uint8Array | string {
    const normalized = resolvePath(path);
    try {
      const bytes = readWorkspaceBytes(reader, normalized, encoder);
      traceFs({ op: "readFileSync", path: normalized, result: encoding ? "text" : "bytes" });
      return encoding ? decodeFsBytes(decoder, bytes) : BrowserBuffer.from(bytes);
    } catch (error) {
      traceFs({ error: fsTraceError(error), op: "readFileSync", path: normalized });
      throw error;
    }
  }

  const facade = {
    constants: constantsBuiltin,
    close(fd: number, callback: (error?: Error | null) => void = () => undefined): void {
      callWithOptionalFsCallback(() => {
        openFiles.delete(fd);
      }, callback);
    },
    closeSync(fd: number): void {
      openFiles.delete(fd);
    },
    chmod(path: string, _mode: number, callback: (error?: Error | null) => void = () => undefined): void {
      callWithOptionalFsCallback(() => {
        statFromReader(reader, resolvePath(path));
      }, callback);
    },
    chmodSync(path: string, _mode?: number): void {
      statFromReader(reader, resolvePath(path));
    },
    chown(path: string, _uid: number, _gid: number, callback: (error?: Error | null) => void = () => undefined): void {
      callWithOptionalFsCallback(() => {
        statFromReader(reader, resolvePath(path));
      }, callback);
    },
    chownSync(path: string, _uid?: number, _gid?: number): void {
      statFromReader(reader, resolvePath(path));
    },
    copyFile(source: string, target: string, flagsOrCallback?: number | ((error?: Error | null) => void), callback?: (error?: Error | null) => void): void {
      const cb = typeof flagsOrCallback === "function" ? flagsOrCallback : callback;
      try {
        facade.copyFileSync(source, target);
        cb?.(null);
      } catch (error) {
        cb?.(error instanceof Error ? error : new Error(String(error)));
      }
    },
    copyFileSync(source: string, target: string): void {
      if (!writer) throw unsupportedFsMutation("copyFileSync");
      const normalizedSource = resolvePath(source);
      const normalizedTarget = resolvePath(target);
      writer.writeText(normalizedTarget, decodeFsBytes(decoder, readWorkspaceBytes(reader, normalizedSource, encoder)));
      notifyFsChange(normalizedTarget, "change");
    },
    cp(source: string, target: string, optionsOrCallback?: CliCpOptions | ((error?: Error | null) => void), callback?: (error?: Error | null) => void): void {
      const cb = typeof optionsOrCallback === "function" ? optionsOrCallback : callback;
      const options = typeof optionsOrCallback === "function" ? {} : optionsOrCallback || {};
      callWithOptionalFsCallback(() => {
        facade.cpSync(source, target, options);
      }, cb || (() => undefined));
    },
    cpSync(source: string, target: string, options: CliCpOptions = {}): void {
      if (!writer) throw unsupportedFsMutation("cpSync");
      const normalizedSource = resolvePath(source);
      const normalizedTarget = resolvePath(target);
      if (options.force === false && facade.existsSync(normalizedTarget)) {
        throw createFsError("EEXIST", `File already exists: ${normalizedTarget}`);
      }
      const stats = statFromReader(reader, normalizedSource);
      if (stats.isDirectory()) {
        if (!options.recursive) throw createFsError("EISDIR", `Cannot copy directory without recursive option: ${normalizedSource}`);
        writer.copyDirectory(normalizedSource, normalizedTarget);
        notifyFsChange(normalizedTarget, "rename");
        return;
      }
      writer.copyFile(normalizedSource, normalizedTarget);
      notifyFsChange(normalizedTarget, "change");
    },
    createReadStream(path: string, options: CliCreateReadStreamOptions | "utf8" | "utf-8" = {}): Readable & { path: string } {
      const stream = new Readable() as Readable & { path: string };
      const normalized = resolvePath(path);
      stream.path = normalized;
      queueMicrotask(() => {
        try {
          stream.emit("open", nextFd++);
          const encodingOption = typeof options === "string" ? options : options.encoding;
          const encoding = encodingOption === "utf8" || encodingOption === "utf-8" ? encodingOption : undefined;
          const data = encoding ? readFileSync(normalized, encoding) : readFileSync(normalized);
          if (encoding) stream.setEncoding(encoding);
          stream.push(data);
          stream.push(null);
        } catch (error) {
          stream.destroy(error);
        }
      });
      return stream;
    },
    createWriteStream(path: string, options: CliCreateWriteStreamOptions = {}): Writable & { path: string } {
      if (!writer) throw unsupportedFsMutation("createWriteStream");
      const normalized = resolvePath(path);
      const chunks: string[] = options.flags?.includes("a") && facade.existsSync(normalized)
        ? [reader.readText(normalized)]
        : [];
      const stream = new Writable({
        write(chunk, _encoding, callback) {
          chunks.push(decodeFsData(chunk as RuntimeFsData));
          callback();
        },
        final(callback) {
          try {
            writer.writeText(normalized, chunks.join(""));
            notifyFsChange(normalized, "change");
            callback();
          } catch (error) {
            callback(error instanceof Error ? error : new Error(String(error)));
          }
        }
      }) as Writable & { path: string };
      stream.path = normalized;
      queueMicrotask(() => {
        stream.emit("open", nextFd++);
      });
      return stream;
    },
    existsSync(path: string): boolean {
      const normalized = resolvePath(path);
      const maybeReader = reader as WorkspaceModuleReader & { exists?: (path: string) => boolean };
      if (maybeReader.exists) {
        const result = maybeReader.exists(normalized);
        traceFs({ op: "existsSync", path: normalized, result });
        return result;
      }
      try {
        reader.readText(normalized);
        traceFs({ op: "existsSync", path: normalized, result: true });
        return true;
      } catch {
        try {
          reader.listDir(normalized);
          traceFs({ op: "existsSync", path: normalized, result: true });
          return true;
        } catch {
          traceFs({ op: "existsSync", path: normalized, result: false });
          return false;
        }
      }
    },
    exists(path: string, callback: (exists: boolean) => void): void {
      // Node's deprecated fs.exists API intentionally uses a single boolean
      // callback rather than the usual error-first callback contract. Yarn
      // Classic still promisifies this API during workspace discovery.
      queueMicrotask(() => callback(facade.existsSync(path)));
    },
    access(path: string, modeOrCallback?: number | ((error?: Error | null) => void), callback?: (error?: Error | null) => void): void {
      const cb = typeof modeOrCallback === "function" ? modeOrCallback : callback;
      try {
        facade.accessSync(path);
        cb?.(null);
      } catch (error) {
        cb?.(error instanceof Error ? error : new Error(String(error)));
      }
    },
    accessSync(path: string): void {
      const normalized = resolvePath(path);
      if (!facade.existsSync(normalized)) throw createFsError("ENOENT", `No such file or directory: ${normalized}`);
    },
    appendFile(path: string, data: RuntimeFsData, optionsOrCallback?: unknown, callback?: (error?: Error | null) => void): void {
      const cb = typeof optionsOrCallback === "function" ? optionsOrCallback as (error?: Error | null) => void : callback;
      callWithOptionalFsCallback(() => {
        facade.appendFileSync(path, data);
      }, cb || (() => undefined));
    },
    appendFileSync(path: string, data: RuntimeFsData): void {
      if (!writer) throw unsupportedFsMutation("appendFileSync");
      const normalized = resolvePath(path);
      let existing = "";
      try {
        existing = reader.readText(normalized);
      } catch (error) {
        const code = typeof error === "object" && error && "code" in error ? (error as { code?: unknown }).code : undefined;
        if (code !== "ENOENT") throw error;
      }
      writer.writeText(normalized, `${existing}${decodeFsData(data)}`);
      touchPath(normalized);
      notifyFsChange(normalized, "change");
    },
    mkdir(path: string, optionsOrCallback?: { recursive?: boolean } | ((error?: Error | null) => void), callback?: (error?: Error | null) => void): void {
      const cb = typeof optionsOrCallback === "function" ? optionsOrCallback : callback;
      try {
        facade.mkdirSync(path);
        cb?.(null);
      } catch (error) {
        cb?.(error instanceof Error ? error : new Error(String(error)));
      }
    },
    mkdirSync(path: string): void {
      if (!writer) throw unsupportedFsMutation("mkdirSync");
      const normalized = resolvePath(path);
      writer.mkdir(normalized);
      touchPath(normalized);
      notifyFsChange(normalized, "rename");
    },
    mkdtemp(prefix: string, optionsOrCallback?: unknown, callback?: (error: Error | null, path?: string) => void): void {
      const cb = typeof optionsOrCallback === "function"
        ? optionsOrCallback as (error: Error | null, path?: string) => void
        : callback;
      if (!cb) return;
      callWithFsCallback(() => facade.mkdtempSync(prefix), cb);
    },
    mkdtempSync(prefix: string): string {
      if (!writer) throw unsupportedFsMutation("mkdtempSync");
      for (let index = 0; index < 1000; index += 1) {
        const path = resolvePath(`${prefix}${index.toString(36).padStart(6, "0")}`);
        if (facade.existsSync(path)) continue;
        writer.mkdir(path);
        return path;
      }
      throw createFsError("EEXIST", `Could not create temporary directory for prefix: ${prefix}`);
    },
    futimes(fd: number, _atime: Date | number | string, _mtime: Date | number | string, callback: (error?: Error | null) => void = () => undefined): void {
      try {
        assertOpenFile(fd);
        callback(null);
      } catch (error) {
        callback(error instanceof Error ? error : new Error(String(error)));
      }
    },
    futimesSync(fd: number): void {
      assertOpenFile(fd);
    },
    fchmod(fd: number, _mode: number, callback: (error?: Error | null) => void = () => undefined): void {
      callWithOptionalFsCallback(() => {
        assertOpenFile(fd);
      }, callback);
    },
    fchmodSync(fd: number, _mode?: number): void {
      assertOpenFile(fd);
    },
    fchown(fd: number, _uid: number, _gid: number, callback: (error?: Error | null) => void = () => undefined): void {
      callWithOptionalFsCallback(() => {
        assertOpenFile(fd);
      }, callback);
    },
    fchownSync(fd: number, _uid?: number, _gid?: number): void {
      assertOpenFile(fd);
    },
    fsync(fd: number, callback: (error?: Error | null) => void = () => undefined): void {
      callWithOptionalFsCallback(() => {
        assertOpenFile(fd);
      }, callback);
    },
    fsyncSync(fd: number): void {
      assertOpenFile(fd);
    },
    lutimes(path: string, atime: Date | number | string, mtime: Date | number | string, callback: (error?: Error | null) => void = () => undefined): void {
      facade.utimes(path, atime, mtime, callback);
    },
    lutimesSync(path: string, atime?: Date | number | string, mtime?: Date | number | string): void {
      facade.utimesSync(path, atime, mtime);
    },
    lstat(path: string, callback: (error: Error | null, stats?: ReturnType<RuntimeFsBinding["statSync"]>) => void): void {
      callWithFsCallback(() => facade.statSync(path) as ReturnType<RuntimeFsBinding["statSync"]>, callback);
    },
    link(source: string, target: string, callback: (error?: Error | null) => void = () => undefined): void {
      try {
        facade.linkSync(source, target);
        callback(null);
      } catch (error) {
        callback(error instanceof Error ? error : new Error(String(error)));
      }
    },
    linkSync(source: string, target: string): void {
      facade.copyFileSync(source, target);
    },
    open(path: string, flags: string | number, modeOrCallback?: number | ((error: Error | null, fd?: number) => void), callback?: (error: Error | null, fd?: number) => void): void {
      const cb = typeof modeOrCallback === "function" ? modeOrCallback : callback;
      if (!cb) return;
      queueMicrotask(() => {
        try {
          const fd = facade.openSync(path, flags);
          cb(null, fd);
        } catch (error) {
          cb(error instanceof Error ? error : new Error(String(error)));
        }
      });
    },
    openSync(path: string, flags: string | number = "r"): number {
      const fd = nextFd++;
      const normalized = resolvePath(path);
      const mode = openMode(flags);
      try {
        openFiles.set(fd, {
          bytes: initialOpenBytes(reader, normalized, mode, encoder),
          path: normalized,
          position: 0,
          writable: mode.writable
        });
        traceFs({ op: "openSync", path: normalized, result: String(flags) });
        return fd;
      } catch (error) {
        traceFs({ error: fsTraceError(error), op: "openSync", path: normalized });
        throw error;
      }
    },
    promises: {
      async access(path: string): Promise<void> {
        facade.accessSync(path);
      },
      async chmod(path: string, mode: number): Promise<void> {
        facade.chmodSync(path, mode);
      },
      async appendFile(path: string, data: RuntimeFsData): Promise<void> {
        facade.appendFileSync(path, data);
      },
      async chown(path: string, uid: number, gid: number): Promise<void> {
        facade.chownSync(path, uid, gid);
      },
      async mkdir(path: string): Promise<void> {
        facade.mkdirSync(path);
      },
      async mkdtemp(prefix: string): Promise<string> {
        return facade.mkdtempSync(prefix);
      },
      async copyFile(source: string, target: string): Promise<void> {
        facade.copyFileSync(source, target);
      },
      async cp(source: string, target: string, options: CliCpOptions = {}): Promise<void> {
        facade.cpSync(source, target, options);
      },
      async fchmod(fd: number, mode: number): Promise<void> {
        facade.fchmodSync(fd, mode);
      },
      async fchown(fd: number, uid: number, gid: number): Promise<void> {
        facade.fchownSync(fd, uid, gid);
      },
      async fsync(fd: number): Promise<void> {
        facade.fsyncSync(fd);
      },
      async link(source: string, target: string): Promise<void> {
        facade.linkSync(source, target);
      },
      async lchmod(path: string, mode: number): Promise<void> {
        facade.chmodSync(path, mode);
      },
      async lchown(path: string, uid: number, gid: number): Promise<void> {
        facade.chownSync(path, uid, gid);
      },
      async lstat(path: string, options?: CliStatOptions): Promise<ReturnType<RuntimeFsBinding["statSync"]> | undefined> {
        return facade.lstatSync(path, options);
      },
      async open(path: string, flags: string | number = "r"): Promise<CliFileHandle> {
        return createFileHandle(facade.openSync(path, flags), facade as CliFileHandleFs);
      },
      async opendir(path: string): Promise<CliDir> {
        return facade.opendirSync(path);
      },
      async readFile(path: string, encoding?: "utf8" | "utf-8"): Promise<Uint8Array | string> {
        return encoding ? readFileSync(path, encoding) : readFileSync(path);
      },
      async readlink(path: string): Promise<string> {
        return facade.readlinkSync(path);
      },
      async readdir(path: string, options?: CliReaddirOptions): Promise<CliDirent[] | string[]> {
        return facade.readdirSync(path, options);
      },
      async realpath(path: string): Promise<string> {
        return facade.realpathSync(path);
      },
      async rename(source: string, target: string): Promise<void> {
        facade.renameSync(source, target);
      },
      async rm(path: string, options: CliRmOptions = {}): Promise<void> {
        facade.rmSync(path, options);
      },
      async rmdir(path: string, options: CliRmOptions = {}): Promise<void> {
        facade.rmdirSync(path, options);
      },
      async stat(path: string, options?: CliStatOptions): Promise<ReturnType<RuntimeFsBinding["statSync"]> | undefined> {
        return facade.statSync(path, options);
      },
      async symlink(target: string, path: string): Promise<void> {
        facade.symlinkSync(target, path);
      },
      async unlink(path: string): Promise<void> {
        facade.unlinkSync(path);
      },
      async utimes(path: string, atime: Date | number | string, mtime: Date | number | string): Promise<void> {
        facade.utimesSync(path, atime, mtime);
      },
      async writeFile(path: string, data: RuntimeFsData): Promise<void> {
        facade.writeFileSync(path, data);
      }
    },
    readFile(path: string, options: unknown, callback?: (error: Error | null, data?: Uint8Array | string) => void): void {
      const cb = typeof options === "function" ? options : callback;
      const encoding = typeof options === "string" ? options : undefined;
      if (!cb) return;
      try {
        cb(null, encoding === "utf8" || encoding === "utf-8" ? readFileSync(path, encoding) : readFileSync(path));
      } catch (error) {
        cb(error instanceof Error ? error : new Error(String(error)));
      }
    },
    readFileSync,
    readlink(path: string, callback: (error: Error | null, target?: string) => void): void {
      callWithFsCallback(() => facade.readlinkSync(path), callback);
    },
    readlinkSync(path: string): string {
      const normalized = resolvePath(path);
      const maybeReader = reader as WorkspaceModuleReader & { readlink?: (path: string) => string };
      if (!maybeReader.readlink) throw createFsError("ENOENT", `No such file or directory: ${normalized}`);
      return maybeReader.readlink(normalized);
    },
    read(fd: number, buffer: Uint8Array, offset: number, length: number, position: number | null, callback: (error: Error | null, bytesRead?: number, buffer?: Uint8Array) => void): void {
      queueMicrotask(() => {
        try {
          const bytesRead = facade.readSync(fd, buffer, offset, length, position) as number;
          callback(null, bytesRead, buffer);
        } catch (error) {
          callback(error instanceof Error ? error : new Error(String(error)));
        }
      });
    },
    readSync(fd: number, buffer?: Uint8Array, offset = 0, length = buffer ? buffer.byteLength - offset : 0, position?: number | null): Uint8Array | number {
      const file = openFiles.get(fd);
      if (!file) throw createFsError("EBADF", `Bad file descriptor: ${fd}`);
      if (!buffer) return file.bytes;
      const start = position ?? file.position;
      const bytes = file.bytes.slice(start, start + length);
      buffer.set(bytes, offset);
      if (position === null || position === undefined) file.position = start + bytes.byteLength;
      return bytes.byteLength;
    },
    opendir(path: string, optionsOrCallback?: unknown, callback?: (error: Error | null, dir?: CliDir) => void): void {
      const cb = typeof optionsOrCallback === "function" ? optionsOrCallback as (error: Error | null, dir?: CliDir) => void : callback;
      if (!cb) return;
      callWithFsCallback(() => facade.opendirSync(path), cb);
    },
    opendirSync(path: string): CliDir {
      const normalized = resolvePath(path);
      const entries = facade.readdirSync(normalized, { withFileTypes: true }) as CliDirent[];
      return createCliDir(normalized, entries);
    },
    readdirSync(path: string, options?: CliReaddirOptions): CliDirent[] | string[] {
      const normalized = resolvePath(path);
      let names: string[];
      try {
        names = reader.listDir(normalized);
        traceFs({ op: "readdirSync", path: normalized, result: String(names.length) });
      } catch (error) {
        traceFs({ error: fsTraceError(error), op: "readdirSync", path: normalized });
        throw error;
      }
      return options?.withFileTypes ? names.map((name) => createDirent(name, normalize(`${normalized}/${name}`), reader)) : names;
    },
    readdir(path: string, optionsOrCallback?: CliReaddirOptions | ((error: Error | null, entries?: CliDirent[] | string[]) => void), callback?: (error: Error | null, entries?: CliDirent[] | string[]) => void): void {
      const cb = typeof optionsOrCallback === "function" ? optionsOrCallback : callback;
      if (!cb) return;
      try {
        const names = facade.readdirSync(path);
        const withFileTypes = typeof optionsOrCallback === "object" && optionsOrCallback?.withFileTypes === true;
        cb(null, withFileTypes ? facade.readdirSync(path, { withFileTypes }) : names);
      } catch (error) {
        cb(error instanceof Error ? error : new Error(String(error)));
      }
    },
    realpath,
    realpathSync,
    rename(source: string, target: string, callback: (error?: Error | null) => void = () => undefined): void {
      try {
        facade.renameSync(source, target);
        callback(null);
      } catch (error) {
        callback(error instanceof Error ? error : new Error(String(error)));
      }
    },
    renameSync(source: string, target: string): void {
      if (!writer?.rename) throw unsupportedFsMutation("renameSync");
      const normalizedSource = resolvePath(source);
      const normalizedTarget = resolvePath(target);
      writer.rename(normalizedSource, normalizedTarget);
      notifyFsChange(normalizedSource, "rename");
      notifyFsChange(normalizedTarget, "rename");
    },
    rm(path: string, optionsOrCallback: CliRmOptions | ((error?: Error | null) => void) = {}, callback?: (error?: Error | null) => void): void {
      const cb = typeof optionsOrCallback === "function" ? optionsOrCallback : callback;
      try {
        facade.rmSync(path, typeof optionsOrCallback === "function" ? {} : optionsOrCallback);
        cb?.(null);
      } catch (error) {
        cb?.(error instanceof Error ? error : new Error(String(error)));
      }
    },
    rmSync(path: string, options: CliRmOptions = {}): void {
      if (!writer) throw unsupportedFsMutation("rmSync");
      const normalized = resolvePath(path);
      if (options.force && !facade.existsSync(normalized)) return;
      writer.remove(normalized);
      notifyFsChange(normalized, "rename");
    },
    rmdir(path: string, optionsOrCallback: CliRmOptions | ((error?: Error | null) => void) = {}, callback?: (error?: Error | null) => void): void {
      facade.rm(path, optionsOrCallback, callback);
    },
    rmdirSync(path: string, options: CliRmOptions = {}): void {
      facade.rmSync(path, options);
    },
    statSync(path: string, options?: CliStatOptions): ReturnType<RuntimeFsBinding["statSync"]> | undefined {
      const normalized = resolvePath(path);
      try {
        const stats = withModifiedTime(normalized, statFromReader(reader, normalized));
        traceFs({ op: "statSync", path: normalized, result: stats.isDirectory() ? "dir" : "file" });
        return stats;
      } catch (error) {
        traceFs({ error: fsTraceError(error), op: "statSync", path: normalized });
        if (options?.throwIfNoEntry === false) return undefined;
        throw error;
      }
    },
    stat(path: string, callback: (error: Error | null, stats?: ReturnType<RuntimeFsBinding["statSync"]>) => void): void {
      callWithFsCallback(() => facade.statSync(path) as ReturnType<RuntimeFsBinding["statSync"]>, callback);
    },
    symlink(target: string, path: string, typeOrCallback?: string | ((error?: Error | null) => void), callback?: (error?: Error | null) => void): void {
      const cb = typeof typeOrCallback === "function" ? typeOrCallback : callback;
      try {
        facade.symlinkSync(target, path);
        cb?.(null);
      } catch (error) {
        cb?.(error instanceof Error ? error : new Error(String(error)));
      }
    },
    symlinkSync(target: string, path: string): void {
      if (!writer?.symlink) throw unsupportedFsMutation("symlinkSync");
      const normalizedPath = resolvePath(path);
      writer.symlink(resolveSymlinkTarget(target, normalizedPath), normalizedPath);
      notifyFsChange(normalizedPath, "rename");
    },
    lstatSync(path: string, options?: CliStatOptions): ReturnType<RuntimeFsBinding["statSync"]> | undefined {
      return facade.statSync(path, options);
    },
    utimes(path: string, _atime: Date | number | string, _mtime: Date | number | string, callback: (error?: Error | null) => void = () => undefined): void {
      try {
        facade.statSync(path);
        callback(null);
      } catch (error) {
        callback(error instanceof Error ? error : new Error(String(error)));
      }
    },
    utimesSync(path: string, _atime?: Date | number | string, _mtime?: Date | number | string): void {
      facade.statSync(path);
    },
    unlink(path: string, callback: (error?: Error | null) => void = () => undefined): void {
      facade.rm(path, callback);
    },
    unlinkSync(path: string): void {
      facade.rmSync(path);
    },
    unwatchFile(path: string, listener?: CliFsStatListener): void {
      const normalized = resolvePath(path);
      if (!listener) {
        statWatchers.delete(normalized);
        return;
      }
      const listeners = statWatchers.get(normalized);
      listeners?.forEach((watcher) => {
        if (watcher.listener === listener) listeners.delete(watcher);
      });
      if (listeners?.size === 0) statWatchers.delete(normalized);
    },
    watch(path: string, optionsOrListener?: CliWatchOptions | CliWatchListener, maybeListener?: CliWatchListener): CliFsWatcher {
      const listener = typeof optionsOrListener === "function" ? optionsOrListener : maybeListener;
      const normalized = resolvePath(path);
      traceFs({ op: "watch", path: normalized, result: listener ? "listener" : "emitter" });
      const watcher = createCliFsWatcher(normalized, listener);
      watchers.add(watcher);
      watcher.once("close", () => {
        watchers.delete(watcher);
      });
      return watcher;
    },
    watchFile(path: string, optionsOrListener?: CliWatchFileOptions | CliFsStatListener, maybeListener?: CliFsStatListener): CliFsStatWatcher {
      const listener = typeof optionsOrListener === "function" ? optionsOrListener : maybeListener;
      if (!listener) throw createFsError("ERR_INVALID_ARG_TYPE", "fs.watchFile listener is required");
      const normalized = resolvePath(path);
      traceFs({ op: "watchFile", path: normalized, result: "listener" });
      const watcher = createCliFsStatWatcher(normalized, listener);
      let listeners = statWatchers.get(normalized);
      if (!listeners) {
        listeners = new Set();
        statWatchers.set(normalized, listeners);
      }
      listeners.add(watcher);
      watcher.once("close", () => {
        listeners?.delete(watcher);
        if (listeners?.size === 0) statWatchers.delete(normalized);
      });
      return watcher;
    },
    writeFileSync(path: string, data: RuntimeFsData): void {
      if (!writer) throw unsupportedFsMutation("writeFileSync");
      const normalized = resolvePath(path);
      writer.writeText(normalized, decodeFsData(data));
      touchPath(normalized);
      notifyFsChange(normalized, "change");
    },
    writeFile(path: string, data: RuntimeFsData, optionsOrCallback?: unknown, callback?: (error?: Error | null) => void): void {
      const cb = typeof optionsOrCallback === "function" ? optionsOrCallback as (error?: Error | null) => void : callback;
      try {
        facade.writeFileSync(path, data);
        cb?.(null);
      } catch (error) {
        cb?.(error instanceof Error ? error : new Error(String(error)));
      }
    },
    write(fd: number, data: RuntimeFsData, offsetOrCallback?: number | ((error: Error | null, bytesWritten?: number, buffer?: RuntimeFsData) => void), lengthOrEncoding?: number | string, positionOrCallback?: number | ((error: Error | null, bytesWritten?: number, buffer?: RuntimeFsData) => void), callback?: (error: Error | null, bytesWritten?: number, buffer?: RuntimeFsData) => void): void {
      const cb = typeof offsetOrCallback === "function"
        ? offsetOrCallback
        : typeof positionOrCallback === "function"
          ? positionOrCallback
          : callback;
      queueMicrotask(() => {
        try {
          const writeOptions: CliWriteOptions = {};
          if (typeof lengthOrEncoding === "string") {
            writeOptions.encoding = lengthOrEncoding;
            if (typeof offsetOrCallback === "number") writeOptions.position = offsetOrCallback;
          } else {
            if (typeof lengthOrEncoding === "number") writeOptions.length = lengthOrEncoding;
            if (typeof offsetOrCallback === "number") writeOptions.offset = offsetOrCallback;
            if (typeof positionOrCallback === "number") writeOptions.position = positionOrCallback;
          }
          const bytesWritten = writeToOpenFile(fd, data, writeOptions);
          cb?.(null, bytesWritten, data);
        } catch (error) {
          cb?.(error instanceof Error ? error : new Error(String(error)));
        }
      });
    },
    writev(fd: number, buffers: ArrayBufferView[], positionOrCallback?: number | ((error?: Error | null, bytesWritten?: number, buffers?: ArrayBufferView[]) => void), callback?: (error?: Error | null, bytesWritten?: number, buffers?: ArrayBufferView[]) => void): void {
      const cb = typeof positionOrCallback === "function" ? positionOrCallback : callback;
      queueMicrotask(() => {
        try {
          let bytesWritten = 0;
          let position = typeof positionOrCallback === "number" ? positionOrCallback : undefined;
          for (const buffer of buffers) {
            const written = writeToOpenFile(fd, buffer, position === undefined ? {} : { position });
            bytesWritten += written;
            if (position !== undefined) position += written;
          }
          cb?.(null, bytesWritten, buffers);
        } catch (error) {
          cb?.(error instanceof Error ? error : new Error(String(error)));
        }
      });
    },
    writeSync(fd: number, data: RuntimeFsData): number {
      return writeToOpenFile(fd, data);
    }
  };

  function CliReadStream(this: Record<string, unknown>, path: string, options: CliCreateReadStreamOptions | "utf8" | "utf-8" = {}) {
    const stream = facade.createReadStream(path, options);
    if (!(this instanceof CliReadStream)) return stream;
    return bindCliFsStream(this, stream);
  }

  function CliWriteStream(this: Record<string, unknown>, path: string, options: CliCreateWriteStreamOptions = {}) {
    const stream = facade.createWriteStream(path, options);
    if (!(this instanceof CliWriteStream)) return stream;
    return bindCliFsStream(this, stream);
  }

  Object.assign(facade, {
    FileReadStream: CliReadStream,
    FileWriteStream: CliWriteStream,
    ReadStream: CliReadStream,
    WriteStream: CliWriteStream
  });

  (facade as RuntimeFsBinding & CliFsDebugBinding).__debugWatchSummary = () => ({
    statWatcherCount: statWatchers.size,
    watcherCount: watchers.size,
    watchedPaths: [
      ...[...watchers].map((watcher) => watcher.path),
      ...statWatchers.keys()
    ].sort()
  });

  return facade as RuntimeFsBinding;

  function notifyFsChange(path: string, eventType: CliWatchEventType): void {
    const normalized = normalize(path);
    const filename = basenameOf(normalized);
    traceFs({ op: `notify:${eventType}`, path: normalized, result: String(watchers.size + statWatchers.size) });
    queueMicrotask(() => {
      for (const watcher of watchers) {
        if (!watcher.closed && watchesPath(watcher.path, normalized)) {
          watcher.emit("change", eventType, filename);
          watcher.listener?.(eventType, filename);
        }
      }
      const listeners = statWatchers.get(normalized);
      if (!listeners) return;
      const current = (() => {
        try {
          return facade.statSync(normalized);
        } catch {
          return undefined;
        }
      })();
      for (const watcher of listeners) {
        if (!watcher.closed) watcher.listener(current, watcher.previous);
        watcher.previous = current;
      }
    });
  }

  function writeToOpenFile(fd: number, data: RuntimeFsData, options: CliWriteOptions = {}): number {
    const file = openFiles.get(fd);
    if (!file) throw createFsError("EBADF", `Bad file descriptor: ${fd}`);
    if (!file.writable || !writer) throw unsupportedFsMutation("writeSync");
    const bytes = encodeFsWriteData(data, options, encoder);
    const position = options.position ?? file.bytes.byteLength;
    const next = new Uint8Array(Math.max(file.bytes.byteLength, position + bytes.byteLength));
    next.set(file.bytes);
    next.set(bytes, position);
    file.bytes = next;
    writer.writeText(file.path, decodeFsBytes(decoder, next));
    touchPath(file.path);
    notifyFsChange(file.path, "change");
    return bytes.byteLength;
  }

  function touchPath(path: string): void {
    nextModifiedTime = Math.max(nextModifiedTime, Date.now());
    let current = normalize(path);
    while (true) {
      modifiedTimes.set(current, nextModifiedTime++);
      if (current === "/") break;
      const parent = normalize(join(current, ".."));
      if (parent === current) break;
      current = parent;
    }
  }

  function withModifiedTime<T extends ReturnType<RuntimeFsBinding["statSync"]>>(path: string, stats: T): T {
    const modifiedTime = modifiedTimes.get(normalize(path)) ?? initialModifiedTime;
    const time = new Date(modifiedTime);
    return {
      ...stats,
      ctime: time,
      ctimeMs: modifiedTime,
      mtime: time,
      mtimeMs: modifiedTime
    };
  }

  function decodeFsData(data: RuntimeFsData): string {
    if (typeof data === "string") return data;
    if (data instanceof Uint8Array) return decodeFsBytes(decoder, data);
    if (ArrayBuffer.isView(data)) return decodeFsBytes(decoder, data);
    return decodeFsBytes(decoder, data);
  }

  function encodeFsWriteData(data: RuntimeFsData, options: CliWriteOptions, encoder: TextEncoder): Uint8Array {
    const source = typeof data === "string"
      ? encoder.encode(data)
      : data instanceof Uint8Array
        ? data
        : ArrayBuffer.isView(data)
          ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
          : new Uint8Array(data);
    const offset = options.offset ?? 0;
    const length = options.length ?? source.byteLength - offset;
    return source.slice(offset, offset + length);
  }

  function assertOpenFile(fd: number): CliOpenFile {
    const file = openFiles.get(fd);
    if (!file) throw createFsError("EBADF", `Bad file descriptor: ${fd}`);
    return file;
  }
}

function bindCliFsStream<T extends Record<string, unknown>>(target: T, stream: Readable | Writable): T {
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

function createFileHandle(fh: number, fs: CliFileHandleFs): CliFileHandle {
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

function callWithFsCallback<T>(read: () => T, callback: (error: Error | null, value?: T) => void): void {
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

function callWithOptionalFsCallback(run: () => void, callback: (error?: Error | null) => void): void {
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

type CliFsRealpath = ((path: string, callback: (error: Error | null, resolvedPath?: string) => void) => void) & {
  native?: CliFsRealpath;
};
type CliFsRealpathSync = ((path: string) => string) & { native?: CliFsRealpathSync };

interface CliOpenFile {
  bytes: Uint8Array;
  path: string;
  position: number;
  writable: boolean;
}

interface CliOpenMode {
  truncate: boolean;
  writable: boolean;
}

interface CliWriteOptions {
  encoding?: string;
  length?: number;
  offset?: number;
  position?: number;
}

interface CliCreateReadStreamOptions {
  encoding?: "utf8" | "utf-8" | null;
}

interface CliCreateWriteStreamOptions {
  flags?: string;
}

interface CliFileHandle {
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

interface CliFileHandleFs {
  closeSync(fd: number): void;
  fchmodSync(fd: number, mode: number): void;
  fchownSync(fd: number, uid: number, gid: number): void;
  fsyncSync(fd: number): void;
  readSync(fd: number, buffer?: Uint8Array, offset?: number, length?: number, position?: number | null): Uint8Array | number;
  writeSync(fd: number, data: RuntimeFsData): number;
}


interface CliRmOptions {
  force?: boolean;
  recursive?: boolean;
}

interface CliCpOptions {
  force?: boolean;
  recursive?: boolean;
}

interface CliReaddirOptions {
  withFileTypes?: boolean;
}

interface CliStatOptions {
  throwIfNoEntry?: boolean;
}

interface CliDirent {
  name: string;
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

interface CliDir extends AsyncIterable<CliDirent> {
  path: string;
  close(): Promise<void>;
  closeSync(): void;
  read(): Promise<CliDirent | null>;
  readSync(): CliDirent | null;
}

type CliWatchEventType = "change" | "rename";
type CliWatchListener = (eventType: CliWatchEventType, filename: string) => void;
type CliFsStat = ReturnType<RuntimeFsBinding["statSync"]>;
type CliFsStatListener = (current: CliFsStat | undefined, previous: CliFsStat | undefined) => void;

interface CliFsDebugBinding {
  __debugWatchSummary?: () => CliEvaluationFsWriteResult;
}

export function getCliFsWatchSummary(fs: RuntimeFsBinding): CliEvaluationFsWriteResult {
  return (fs as RuntimeFsBinding & CliFsDebugBinding).__debugWatchSummary?.() ?? {
    statWatcherCount: 0,
    watcherCount: 0,
    watchedPaths: []
  };
}

interface CliWatchOptions {
  persistent?: boolean;
  recursive?: boolean;
}

interface CliWatchFileOptions {
  bigint?: boolean;
  interval?: number;
  persistent?: boolean;
}

type CliFsWatcher = EventEmitter & {
  closed: boolean;
  close(): void;
  listener?: CliWatchListener;
  path: string;
  ref(): CliFsWatcher;
  unref(): CliFsWatcher;
};

type CliFsStatWatcher = EventEmitter & {
  closed: boolean;
  close(): void;
  listener: CliFsStatListener;
  path: string;
  previous: CliFsStat | undefined;
  ref(): CliFsStatWatcher;
  unref(): CliFsStatWatcher;
};


function createCliFsWatcher(path: string, listener?: CliWatchListener): CliFsWatcher {
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

function createCliFsStatWatcher(path: string, listener: CliFsStatListener): CliFsStatWatcher {
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

function createCliDir(path: string, entries: CliDirent[]): CliDir {
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

function watchesPath(watchPath: string, changedPath: string): boolean {
  return watchPath === changedPath || changedPath.startsWith(`${watchPath}/`);
}

function basenameOf(path: string): string {
  const normalized = normalize(path);
  const index = normalized.lastIndexOf("/");
  return index === -1 ? normalized : normalized.slice(index + 1);
}

function statFromReader(reader: WorkspaceModuleReader, path: string): ReturnType<RuntimeFsBinding["statSync"]> {
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

function hashInode(path: string): number {
  let hash = 2166136261;
  for (let index = 0; index < path.length; index += 1) {
    hash ^= path.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function unsupportedFsMutation(method: string): Error {
  return createFsError("ERR_BROWSER_FS_MUTATION_UNSUPPORTED", `fs.${method} is not supported by CLI module evaluator`);
}

function createDirent(name: string, path: string, reader: WorkspaceModuleReader): CliDirent {
  const stats = statFromReader(reader, path);
  return {
    name,
    isDirectory: () => stats.isDirectory(),
    isFile: () => stats.isFile(),
    isSymbolicLink: () => false
  };
}

function createFsError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

function openMode(flags: string | number): CliOpenMode {
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

function initialOpenBytes(reader: WorkspaceModuleReader, path: string, mode: CliOpenMode, encoder: TextEncoder): Uint8Array {
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

function resolveSymlinkTarget(target: string, linkPath: string): string {
  if (target.startsWith("/")) return normalize(target);
  return normalize(`${dirnameOf(linkPath)}/${target}`);
}

function dirnameOf(path: string): string {
  const normalized = normalize(path);
  const index = normalized.lastIndexOf("/");
  return index <= 0 ? "/" : normalized.slice(0, index);
}
