import { createBuiltinLoader } from "../builtin-loader.ts";
import { constantsBuiltin } from "../builtins/constants.ts";
import { normalize } from "../builtins/path.ts";
import { BrowserProcess } from "../builtins/process.ts";
import { createWorkspaceModuleRuntime, type WorkspaceModuleReader } from "../modules/index.ts";
import type { CliEntry, CliRunResult, RuntimeEnv, RuntimeFsBinding, RuntimeNamespace } from "../types.ts";

export interface CliModuleEvaluatorOptions {
  reader: WorkspaceModuleReader;
  root?: string;
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
  const globalObject: Record<string, unknown> = {
    __dynamicImport: createCliDynamicImport()
  };
  const consoleObject = createCliConsole(process);
  const fs = createWorkspaceFsFacade(options.reader);

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
    const message = error instanceof Error ? error.message : String(error);
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

function createWorkspaceFsFacade(reader: WorkspaceModuleReader): RuntimeFsBinding {
  const decoder = new TextDecoder();
  let nextFd = 3;
  const openFiles = new Map<number, Uint8Array>();
  const realpath: CliFsRealpath = (path, callback) => {
    callback(null, normalize(path));
  };
  realpath.native = realpath;

  function readFileSync(path: string): Uint8Array;
  function readFileSync(path: string, encoding: "utf8" | "utf-8"): string;
  function readFileSync(path: string, encoding?: "utf8" | "utf-8"): Uint8Array | string {
    const bytes = new TextEncoder().encode(reader.readText(normalize(path)));
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
    mkdirSync(_path: string): void {
      throw unsupportedFsMutation("mkdirSync");
    },
    open(path: string, _flags: string, callback: (error: Error | null, fd?: number) => void): void {
      try {
        const fd = facade.openSync(path);
        callback(null, fd);
      } catch (error) {
        callback(error instanceof Error ? error : new Error(String(error)));
      }
    },
    openSync(path: string): number {
      const fd = nextFd++;
      openFiles.set(fd, new TextEncoder().encode(reader.readText(normalize(path))));
      return fd;
    },
    promises: {
      async mkdir(_path: string): Promise<void> {
        throw unsupportedFsMutation("promises.mkdir");
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
      async stat(path: string): Promise<ReturnType<RuntimeFsBinding["statSync"]>> {
        return facade.statSync(path);
      },
      async writeFile(_path: string): Promise<void> {
        throw unsupportedFsMutation("promises.writeFile");
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
      const bytes = openFiles.get(fd);
      if (!bytes) throw createFsError("EBADF", `Bad file descriptor: ${fd}`);
      return bytes;
    },
    readdirSync(path: string): string[] {
      return reader.listDir(normalize(path));
    },
    realpath,
    realpathSync(path: string): string {
      return normalize(path);
    },
    statSync(path: string): ReturnType<RuntimeFsBinding["statSync"]> {
      return statFromReader(reader, path);
    },
    lstatSync(path: string): ReturnType<RuntimeFsBinding["statSync"]> {
      return statFromReader(reader, path);
    },
    writeFileSync(_path: string): void {
      throw unsupportedFsMutation("writeFileSync");
    },
    writev(_fd: number, _buffers: ArrayBufferView[], callback: (error?: Error | null, bytesWritten?: number, buffers?: ArrayBufferView[]) => void = () => undefined): void {
      callback(unsupportedFsMutation("writev"));
    },
    writeSync(): number {
      throw unsupportedFsMutation("writeSync");
    }
  };
  return facade as RuntimeFsBinding;
}

type CliFsRealpath = ((path: string, callback: (error: Error | null, resolvedPath?: string) => void) => void) & {
  native?: CliFsRealpath;
};

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

function parseProcessExit(message: string): number | null {
  const match = message.match(/^process\.exit\((\d+)\)$/);
  return match ? Number(match[1]) : null;
}
