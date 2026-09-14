import { createBuiltinLoader } from "../builtin-loader.ts";
import { normalize } from "../builtins/path.ts";
import { BrowserProcess } from "../builtins/process.ts";
import { createWorkspaceModuleRuntime, type WorkspaceModuleReader } from "../modules/index.ts";
import type { CliEntry, CliRunResult, RuntimeEnv, RuntimeFsBinding } from "../types.ts";

export interface CliModuleEvaluatorOptions {
  reader: WorkspaceModuleReader;
  root?: string;
}

export interface CliModuleEvaluationRequest {
  entry: CliEntry;
  args: string[];
  cwd: string;
  env?: RuntimeEnv;
}

export function createCliModuleEvaluator(options: CliModuleEvaluatorOptions): (request: CliModuleEvaluationRequest) => CliRunResult {
  return function evaluateCliModule(request: CliModuleEvaluationRequest): CliRunResult {
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
    const globalObject: Record<string, unknown> = {};
    const fs = createWorkspaceFsFacade(options.reader);

    const runtime = createWorkspaceModuleRuntime({
      root: options.root || "/workspace",
      reader: options.reader,
      builtins: createBuiltinLoader({ fs, process }),
      globals: {
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
    if (process.exitCode !== undefined) exitCode = process.exitCode;

    return {
      stdout,
      stderr,
      exitCode,
      entry: request.entry.entry,
      ...(request.entry.entrySha256 ? { entrySha256: request.entry.entrySha256 } : {})
    };
  };
}

function createWorkspaceFsFacade(reader: WorkspaceModuleReader): RuntimeFsBinding {
  const decoder = new TextDecoder();
  let nextFd = 3;
  const openFiles = new Map<number, Uint8Array>();

  function readFileSync(path: string): Uint8Array;
  function readFileSync(path: string, encoding: "utf8" | "utf-8"): string;
  function readFileSync(path: string, encoding?: "utf8" | "utf-8"): Uint8Array | string {
    const bytes = new TextEncoder().encode(reader.readText(normalize(path)));
    return encoding ? decoder.decode(bytes) : bytes;
  }

  const facade = {
    close(fd: number, callback: (error?: Error | null) => void = () => undefined): void {
      openFiles.delete(fd);
      callback(null);
    },
    closeSync(fd: number): void {
      openFiles.delete(fd);
    },
    existsSync(path: string): boolean {
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
    writeSync(): number {
      throw unsupportedFsMutation("writeSync");
    }
  };
  return facade as RuntimeFsBinding;
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

function parseProcessExit(message: string): number | null {
  const match = message.match(/^process\.exit\((\d+)\)$/);
  return match ? Number(match[1]) : null;
}
