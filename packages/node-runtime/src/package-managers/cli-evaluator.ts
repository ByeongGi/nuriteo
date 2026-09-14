import { createBuiltinLoader } from "../builtin-loader.ts";
import { Buffer as BrowserBuffer } from "../builtins/buffer.ts";
import { constantsBuiltin } from "../builtins/constants.ts";
import { normalize } from "../builtins/path.ts";
import { BrowserProcess } from "../builtins/process.ts";
import { createWorkspaceModuleRuntime, type WorkspaceModuleReader } from "../modules/index.ts";
import type { CliEntry, CliRunResult, RuntimeEnv, RuntimeFsBinding, RuntimeFsData, RuntimeNamespace } from "../types.ts";
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
    clearTimeout,
    setTimeout
  };
  const consoleObject = createCliConsole(process);
  const fs = createWorkspaceFsFacade(options.reader, options.writer);

  const runtime = createWorkspaceModuleRuntime({
    root: options.root || "/workspace",
    reader: options.reader,
    builtins: createBuiltinLoader({ fs, process }),
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
    return encoding ? decoder.decode(bytes) : bytes;
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
    lutimes(path: string, atime: Date | number | string, mtime: Date | number | string, callback: (error?: Error | null) => void = () => undefined): void {
      facade.utimes(path, atime, mtime, callback);
    },
    lutimesSync(path: string, atime?: Date | number | string, mtime?: Date | number | string): void {
      facade.utimesSync(path, atime, mtime);
    },
    lstat(path: string, callback: (error: Error | null, stats?: ReturnType<RuntimeFsBinding["statSync"]>) => void): void {
      callWithFsCallback(() => facade.lstatSync(path), callback);
    },
    open(path: string, flags: string | number, callback: (error: Error | null, fd?: number) => void): void {
      try {
        const fd = facade.openSync(path, flags);
        callback(null, fd);
      } catch (error) {
        callback(error instanceof Error ? error : new Error(String(error)));
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
      async lstat(path: string): Promise<ReturnType<RuntimeFsBinding["statSync"]>> {
        return facade.lstatSync(path);
      },
      async readFile(path: string, encoding?: "utf8" | "utf-8"): Promise<Uint8Array | string> {
        return encoding ? readFileSync(path, encoding) : readFileSync(path);
      },
      async readdir(path: string): Promise<string[]> {
        return facade.readdirSync(path);
      },
      async realpath(path: string): Promise<string> {
        return facade.realpathSync(path);
      },
      async rm(path: string, options: CliRmOptions = {}): Promise<void> {
        facade.rmSync(path, options);
      },
      async rmdir(path: string, options: CliRmOptions = {}): Promise<void> {
        facade.rmdirSync(path, options);
      },
      async stat(path: string): Promise<ReturnType<RuntimeFsBinding["statSync"]>> {
        return facade.statSync(path);
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
    readSync(fd: number): Uint8Array {
      const file = openFiles.get(fd);
      if (!file) throw createFsError("EBADF", `Bad file descriptor: ${fd}`);
      return file.bytes;
    },
    readdirSync(path: string): string[] {
      return reader.listDir(normalize(path));
    },
    realpath,
    realpathSync(path: string): string {
      return normalize(path);
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
    statSync(path: string): ReturnType<RuntimeFsBinding["statSync"]> {
      return statFromReader(reader, path);
    },
    stat(path: string, callback: (error: Error | null, stats?: ReturnType<RuntimeFsBinding["statSync"]>) => void): void {
      callWithFsCallback(() => facade.statSync(path), callback);
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
    lstatSync(path: string): ReturnType<RuntimeFsBinding["statSync"]> {
      return statFromReader(reader, path);
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
    writev(_fd: number, _buffers: ArrayBufferView[], callback: (error?: Error | null, bytesWritten?: number, buffers?: ArrayBufferView[]) => void = () => undefined): void {
      callback(unsupportedFsMutation("writev"));
    },
    writeSync(fd: number, data: RuntimeFsData): number {
      const file = openFiles.get(fd);
      if (!file) throw createFsError("EBADF", `Bad file descriptor: ${fd}`);
      if (!file.writable || !writer) throw unsupportedFsMutation("writeSync");
      const decoded = decodeFsData(data);
      const next = `${decoder.decode(file.bytes)}${decoded}`;
      file.bytes = encoder.encode(next);
      writer.writeText(file.path, next);
      return encoder.encode(decoded).byteLength;
    }
  };
  return facade as RuntimeFsBinding;

  function decodeFsData(data: RuntimeFsData): string {
    if (typeof data === "string") return data;
    if (data instanceof Uint8Array) return decoder.decode(data);
    if (ArrayBuffer.isView(data)) return decoder.decode(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    return decoder.decode(new Uint8Array(data));
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

interface CliRmOptions {
  force?: boolean;
  recursive?: boolean;
}

interface HostProcessLike {
  on?(event: "uncaughtException" | "unhandledRejection", listener: (error: unknown) => void): unknown;
  off?(event: "uncaughtException" | "unhandledRejection", listener: (error: unknown) => void): unknown;
}

function statFromReader(reader: WorkspaceModuleReader, path: string): ReturnType<RuntimeFsBinding["statSync"]> {
  try {
    const size = new TextEncoder().encode(reader.readText(normalize(path))).byteLength;
    return {
      size,
      isFile: () => true,
      isDirectory: () => false
    };
  } catch {
    reader.listDir(normalize(path));
    return {
      size: 0,
      isFile: () => false,
      isDirectory: () => true
    };
  }
}

function unsupportedFsMutation(method: string): Error {
  return createFsError("ERR_BROWSER_FS_MUTATION_UNSUPPORTED", `fs.${method} is not supported by CLI module evaluator`);
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
