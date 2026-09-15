import { createBuiltinLoader } from "../builtin-loader.ts";
import { Buffer as BrowserBuffer } from "../builtins/buffer.ts";
import { constantsBuiltin } from "../builtins/constants.ts";
import { EventEmitter } from "../builtins/events.ts";
import { normalize } from "../builtins/path.ts";
import { BrowserProcess } from "../builtins/process.ts";
import { createWorkspaceModuleRuntime, type WorkspaceModuleReader } from "../modules/index.ts";
import type { CliEntry, CliRunResult, RuntimeEnv, RuntimeFsBinding, RuntimeFsData, RuntimeNamespace, RuntimeValue } from "../types.ts";
import type { PackageManagerWorkspaceWriter } from "./workspace.ts";

export interface CliModuleEvaluatorOptions {
  reader: WorkspaceModuleReader;
  root?: string;
  writer?: PackageManagerWorkspaceWriter;
}

export interface AsyncCliModuleEvaluatorOptions extends CliModuleEvaluatorOptions {
  settleTicks?: number;
  settleTimeoutMs?: number;
}

export interface CliModuleEvaluationRequest {
  entry: CliEntry;
  args: string[];
  cwd: string;
  env?: RuntimeEnv;
}

export function createCliModuleEvaluator(options: CliModuleEvaluatorOptions): (request: CliModuleEvaluationRequest) => CliRunResult {
  return function evaluateCliModule(request: CliModuleEvaluationRequest): CliRunResult {
    return startCliModuleEvaluation(options, request).finalize();
  };
}

export function createAsyncCliModuleEvaluator(options: AsyncCliModuleEvaluatorOptions): (request: CliModuleEvaluationRequest) => Promise<CliRunResult> {
  return async function evaluateCliModuleAsync(request: CliModuleEvaluationRequest): Promise<CliRunResult> {
    const evaluation = startCliModuleEvaluation(options, request);
    await settleCliEvaluation(options);
    return evaluation.finalize();
  };
}

function startCliModuleEvaluation(options: CliModuleEvaluatorOptions, request: CliModuleEvaluationRequest): { finalize: () => CliRunResult } {
  let stdout = "";
  let stderr = "";
  let asyncExitCode: number | undefined;
  const processOptions = {
    argv: ["node", request.entry.entry, ...request.args],
    cwd: request.cwd,
    exitMode: "capture" as const,
    ...(request.env ? { env: request.env } : {})
  };
  const process = new BrowserProcess(processOptions);
  process.on("stdout", (chunk) => {
    stdout += String(chunk);
  });
  process.on("stderr", (chunk) => {
    stderr += String(chunk);
  });
  const restoreHostErrorCapture = captureHostAsyncErrors((error) => {
    asyncExitCode = 1;
    stderr += `${errorMessage(error)}\n`;
  });
  const globalObject: Record<string, unknown> = {
    ArrayBuffer,
    Buffer: BrowserBuffer,
    Uint8Array,
    __dynamicImport: createCliDynamicImport(),
    clearImmediate: clearCliImmediate,
    clearTimeout,
    setImmediate: setCliImmediate,
    setTimeout
  };
  const consoleObject = createCliConsole(process);
  const fs = createWorkspaceFsFacade(options.reader, options.writer);

  const workerThreads = createCliWorkerThreadsBuiltin({
    fs,
    globals: globalObject,
    parentProcess: process,
    reader: options.reader,
    root: options.root || "/workspace"
  });

  const runtime = createWorkspaceModuleRuntime({
    root: options.root || "/workspace",
    reader: options.reader,
    builtins: createBuiltinLoader({ fs, process, workerThreads }),
    globals: {
      __dynamicImport: globalObject.__dynamicImport,
      console: consoleObject,
      global: globalObject,
      process
    }
  });

  let exitCode = 0;
  try {
    runtime.requireSync(request.entry.entry, request.entry.entry);
  } catch (error) {
    const message = errorMessage(error);
    const exit = parseProcessExit(message);
    if (exit !== null) {
      exitCode = exit;
    } else {
      exitCode = 1;
      stderr += `${message}\n`;
    }
  }

  return {
    finalize() {
      restoreHostErrorCapture();
      if (asyncExitCode !== undefined) exitCode = asyncExitCode;
      if (process.exitCode !== undefined) exitCode = process.exitCode;
      return {
        stdout,
        stderr,
        exitCode,
        entry: request.entry.entry,
        ...(request.entry.entrySha256 ? { entrySha256: request.entry.entrySha256 } : {})
      };
    }
  };
}

function createCliWorkerThreadsBuiltin(options: {
  fs: RuntimeFsBinding;
  globals: Record<string, unknown>;
  parentProcess: BrowserProcess;
  reader: WorkspaceModuleReader;
  root: string;
}): RuntimeNamespace {
  type InlineParentPort = EventEmitter & {
    postMessage: (value: unknown) => void;
    ref: () => InlineParentPort;
    unref: () => InlineParentPort;
  };

  class InlineWorker extends EventEmitter {
    readonly stdin = null;
    readonly stdout = null;
    readonly stderr = null;
    readonly resourceLimits = Object.freeze({});
    readonly threadId: number;
    readonly workerData: unknown;
    #parentPort = new EventEmitter() as InlineParentPort;
    #terminated = false;

    constructor(filename: string | URL, workerOptions: { eval?: boolean; workerData?: unknown } = {}) {
      super();
      this.threadId = nextInlineWorkerThreadId++;
      this.workerData = workerOptions.workerData;
      if (workerOptions.eval) {
        queueMicrotask(() => this.#fail(new Error("eval workers are not supported by CLI module evaluator")));
        return;
      }

      this.#parentPort.postMessage = (value: unknown) => {
        queueMicrotask(() => {
          if (!this.#terminated) this.emit("message", value);
        });
      };
      this.#parentPort.ref = () => this.#parentPort;
      this.#parentPort.unref = () => this.#parentPort;
      try {
        const workerGlobal: Record<string, unknown> = {
          ...options.globals
        };
        const workerProcess = new BrowserProcess({
          argv: ["node", String(filename)],
          cwd: options.parentProcess.cwd(),
          env: options.parentProcess.env,
          exitMode: "capture"
        });
        workerGlobal.global = workerGlobal;
        workerGlobal.process = workerProcess;
        const workerThreads = createWorkerContextBuiltin(this.#parentPort, this.threadId, this.workerData);
        const runtime = createWorkspaceModuleRuntime({
          root: options.root,
          reader: options.reader,
          builtins: createBuiltinLoader({
            fs: options.fs,
            process: workerProcess,
            workerThreads
          }),
          globals: workerGlobal
        });
        runtime.requireSync(normalize(String(filename)), normalize(String(filename)));
      } catch (error) {
        queueMicrotask(() => this.#fail(error instanceof Error ? error : new Error(String(error))));
      }
    }

    postMessage(value: unknown): void {
      if (this.#terminated) return;
      queueMicrotask(() => this.#parentPort.emit("message", value));
    }

    terminate(): Promise<number> {
      if (this.#terminated) return Promise.resolve(0);
      this.#terminated = true;
      this.#parentPort.removeAllListeners();
      this.emit("exit", 0);
      return Promise.resolve(0);
    }

    ref(): this {
      return this;
    }

    unref(): this {
      return this;
    }

    #fail(error: Error): void {
      this.emit("error", error);
    }
  }

  return Object.freeze({
    Worker: InlineWorker,
    isMainThread: true,
    parentPort: null,
    threadId: 0,
    workerData: null
  });
}

function createWorkerContextBuiltin(parentPort: RuntimeValue, threadId: number, workerData: unknown): RuntimeNamespace {
  return Object.freeze({
    Worker: class UnsupportedNestedWorker extends EventEmitter {},
    isMainThread: false,
    parentPort,
    threadId,
    workerData
  });
}

let nextInlineWorkerThreadId = 1;

function setCliImmediate(callback: (...args: unknown[]) => void, ...args: unknown[]): ReturnType<typeof setTimeout> {
  return setTimeout(() => callback(...args), 0);
}

function clearCliImmediate(handle: ReturnType<typeof setTimeout>): void {
  clearTimeout(handle);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function captureHostAsyncErrors(onError: (error: unknown) => void): () => void {
  const hostProcess = (globalThis as typeof globalThis & { process?: HostProcessLike }).process;
  if (!hostProcess?.on || !hostProcess.off) return () => undefined;

  const onUncaughtException = (error: unknown) => {
    onError(error);
  };
  const onUnhandledRejection = (reason: unknown) => {
    onError(reason);
  };
  hostProcess.on("uncaughtException", onUncaughtException);
  hostProcess.on("unhandledRejection", onUnhandledRejection);
  return () => {
    hostProcess.off?.("uncaughtException", onUncaughtException);
    hostProcess.off?.("unhandledRejection", onUnhandledRejection);
  };
}

function createCliConsole(process: BrowserProcess): Pick<Console, "error" | "log" | "warn"> {
  return {
    error(...values: unknown[]) {
      process.stderr.write(`${values.join(" ")}\n`);
    },
    log(...values: unknown[]) {
      process.stdout.write(`${values.join(" ")}\n`);
    },
    warn(...values: unknown[]) {
      process.stderr.write(`${values.join(" ")}\n`);
    }
  };
}

async function settleCliEvaluation(options: AsyncCliModuleEvaluatorOptions): Promise<void> {
  const ticks = options.settleTicks ?? 8;
  const timeoutMs = options.settleTimeoutMs ?? 0;
  for (let index = 0; index < ticks; index += 1) {
    await Promise.resolve();
  }
  if (timeoutMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, timeoutMs));
  }
}

function createCliDynamicImport(): (specifier: string) => Promise<RuntimeNamespace> {
  return async (specifier: string): Promise<RuntimeNamespace> => {
    if (specifier === "chalk") return createChalkNamespace();
    if (specifier === "supports-color") return createSupportsColorNamespace();
    throw new Error(`ERR_BROWSER_DYNAMIC_IMPORT_UNSUPPORTED: ${specifier}`);
  };
}

function createChalkNamespace(): RuntimeNamespace {
  class Chalk {
    level: number;

    constructor(options: { level?: number } = {}) {
      this.level = options.level ?? 0;
      return createPassthroughChalk(this.level);
    }
  }

  const defaultChalk = createPassthroughChalk(0);
  return {
    Chalk,
    default: defaultChalk
  };
}

function createPassthroughChalk(level: number): ((...values: unknown[]) => string) & { level: number } {
  const chalk = ((...values: unknown[]) => values.join(" ")) as ((...values: unknown[]) => string) & { level: number };
  chalk.level = level;
  const proxy = new Proxy(chalk, {
    get(target, property, receiver) {
      if (property in target) return Reflect.get(target, property, receiver);
      return proxy;
    }
  });
  return proxy;
}

function createSupportsColorNamespace(): RuntimeNamespace {
  const createSupportsColor = () => ({ hasBasic: false, has256: false, has16m: false, level: 0 });
  return {
    createSupportsColor,
    default: {
      stdout: false,
      stderr: false
    },
    stdout: false,
    stderr: false
  };
}

function createWorkspaceFsFacade(reader: WorkspaceModuleReader, writer?: PackageManagerWorkspaceWriter): RuntimeFsBinding {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let nextFd = 3;
  const openFiles = new Map<number, CliOpenFile>();
  const realpath: CliFsRealpath = (path, callback) => {
    callback(null, normalize(path));
  };
  realpath.native = realpath;

  function readFileSync(path: string): Uint8Array;
  function readFileSync(path: string, encoding: "utf8" | "utf-8"): string;
  function readFileSync(path: string, encoding?: "utf8" | "utf-8"): Uint8Array | string {
    const bytes = encoder.encode(reader.readText(normalize(path)));
    return encoding ? decoder.decode(bytes) : BrowserBuffer.from(bytes);
  }

  const facade = {
    constants: constantsBuiltin,
    close(fd: number, callback: (error?: Error | null) => void = () => undefined): void {
      openFiles.delete(fd);
      callback(null);
    },
    closeSync(fd: number): void {
      openFiles.delete(fd);
    },
    chmod(path: string, _mode: number, callback: (error?: Error | null) => void = () => undefined): void {
      callWithOptionalFsCallback(() => {
        statFromReader(reader, path);
      }, callback);
    },
    chmodSync(path: string): void {
      statFromReader(reader, path);
    },
    chown(path: string, _uid: number, _gid: number, callback: (error?: Error | null) => void = () => undefined): void {
      callWithOptionalFsCallback(() => {
        statFromReader(reader, path);
      }, callback);
    },
    chownSync(path: string): void {
      statFromReader(reader, path);
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
      writer.writeText(normalize(target), reader.readText(normalize(source)));
    },
    existsSync(path: string): boolean {
      const maybeReader = reader as WorkspaceModuleReader & { exists?: (path: string) => boolean };
      if (maybeReader.exists) return maybeReader.exists(normalize(path));
      try {
        reader.readText(normalize(path));
        return true;
      } catch {
        try {
          reader.listDir(normalize(path));
          return true;
        } catch {
          return false;
        }
      }
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
      if (!facade.existsSync(path)) throw createFsError("ENOENT", `No such file or directory: ${normalize(path)}`);
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
      writer.mkdir(normalize(path));
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
      callWithFsCallback(() => statFromReader(reader, path), callback);
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
      try {
        const fd = facade.openSync(path, flags);
        cb(null, fd);
      } catch (error) {
        cb(error instanceof Error ? error : new Error(String(error)));
      }
    },
    openSync(path: string, flags: string | number = "r"): number {
      const fd = nextFd++;
      const normalized = normalize(path);
      const mode = openMode(flags);
      openFiles.set(fd, {
        bytes: initialOpenBytes(reader, normalized, mode, encoder),
        path: normalized,
        writable: mode.writable
      });
      return fd;
    },
    promises: {
      async mkdir(path: string): Promise<void> {
        facade.mkdirSync(path);
      },
      async copyFile(source: string, target: string): Promise<void> {
        facade.copyFileSync(source, target);
      },
      async link(source: string, target: string): Promise<void> {
        facade.linkSync(source, target);
      },
      async lstat(path: string, options?: CliStatOptions): Promise<ReturnType<RuntimeFsBinding["statSync"]> | undefined> {
        return facade.lstatSync(path, options);
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
      const maybeReader = reader as WorkspaceModuleReader & { readlink?: (path: string) => string };
      if (!maybeReader.readlink) throw createFsError("ENOENT", `No such file or directory: ${normalize(path)}`);
      return maybeReader.readlink(normalize(path));
    },
    readSync(fd: number): Uint8Array {
      const file = openFiles.get(fd);
      if (!file) throw createFsError("EBADF", `Bad file descriptor: ${fd}`);
      return file.bytes;
    },
    readdirSync(path: string, options?: CliReaddirOptions): CliDirent[] | string[] {
      const normalized = normalize(path);
      const names = reader.listDir(normalized);
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
    realpathSync(path: string): string {
      return normalize(path);
    },
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
      writer.rename(normalize(source), normalize(target));
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
      if (options.force && !facade.existsSync(path)) return;
      writer.remove(normalize(path));
    },
    rmdir(path: string, optionsOrCallback: CliRmOptions | ((error?: Error | null) => void) = {}, callback?: (error?: Error | null) => void): void {
      facade.rm(path, optionsOrCallback, callback);
    },
    rmdirSync(path: string, options: CliRmOptions = {}): void {
      facade.rmSync(path, options);
    },
    statSync(path: string, options?: CliStatOptions): ReturnType<RuntimeFsBinding["statSync"]> | undefined {
      try {
        return statFromReader(reader, path);
      } catch (error) {
        if (options?.throwIfNoEntry === false) return undefined;
        throw error;
      }
    },
    stat(path: string, callback: (error: Error | null, stats?: ReturnType<RuntimeFsBinding["statSync"]>) => void): void {
      callWithFsCallback(() => statFromReader(reader, path), callback);
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
      writer.symlink(resolveSymlinkTarget(target, path), normalize(path));
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
    writeFileSync(path: string, data: RuntimeFsData): void {
      if (!writer) throw unsupportedFsMutation("writeFileSync");
      writer.writeText(normalize(path), decodeFsData(data));
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
    },
    writev(_fd: number, _buffers: ArrayBufferView[], callback: (error?: Error | null, bytesWritten?: number, buffers?: ArrayBufferView[]) => void = () => undefined): void {
      callback(unsupportedFsMutation("writev"));
    },
    writeSync(fd: number, data: RuntimeFsData): number {
      return writeToOpenFile(fd, data);
    }
  };

  return facade as RuntimeFsBinding;

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
    writer.writeText(file.path, decoder.decode(next));
    return bytes.byteLength;
  }

  function decodeFsData(data: RuntimeFsData): string {
    if (typeof data === "string") return data;
    if (data instanceof Uint8Array) return decoder.decode(data);
    if (ArrayBuffer.isView(data)) return decoder.decode(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    return decoder.decode(new Uint8Array(data));
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

function callWithFsCallback<T>(read: () => T, callback: (error: Error | null, value?: T) => void): void {
  try {
    callback(null, read());
  } catch (error) {
    callback(error instanceof Error ? error : new Error(String(error)));
  }
}

function callWithOptionalFsCallback(run: () => void, callback: (error?: Error | null) => void): void {
  try {
    run();
    callback(null);
  } catch (error) {
    callback(error instanceof Error ? error : new Error(String(error)));
  }
}

type CliFsRealpath = ((path: string, callback: (error: Error | null, resolvedPath?: string) => void) => void) & {
  native?: CliFsRealpath;
};

interface CliOpenFile {
  bytes: Uint8Array;
  path: string;
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

interface CliRmOptions {
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

interface HostProcessLike {
  on?(event: "uncaughtException" | "unhandledRejection", listener: (error: unknown) => void): unknown;
  off?(event: "uncaughtException" | "unhandledRejection", listener: (error: unknown) => void): unknown;
}

function statFromReader(reader: WorkspaceModuleReader, path: string): ReturnType<RuntimeFsBinding["statSync"]> {
  try {
    const size = new TextEncoder().encode(reader.readText(normalize(path))).byteLength;
    return {
      ino: hashInode(normalize(path)),
      mode: 0o100644,
      size,
      isFile: () => true,
      isDirectory: () => false,
      isSymbolicLink: () => false
    };
  } catch {
    reader.listDir(normalize(path));
    return {
      ino: hashInode(normalize(path)),
      mode: 0o040755,
      size: 0,
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
    return encoder.encode(reader.readText(path));
  } catch (error) {
    if (mode.writable) return new Uint8Array();
    throw error;
  }
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

function parseProcessExit(message: string): number | null {
  const match = message.match(/^process\.exit\((\d+)\)$/);
  return match ? Number(match[1]) : null;
}
