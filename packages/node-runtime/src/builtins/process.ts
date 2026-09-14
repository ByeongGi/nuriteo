import { EventEmitter } from "./events.ts";

export type ProcessExitMode = "throw" | "capture";
type ProcessWriteCallback = () => void;
type ProcessWriteEncoding = BufferEncoding | string;

export interface ProcessBuiltinOptions {
  argv?: string[];
  cwd?: string;
  env?: Record<string, string>;
  exitMode?: ProcessExitMode;
}

export class BrowserProcess extends EventEmitter {
  argv: string[];
  env: Record<string, string>;
  exitCode: number | undefined;
  execPath = "/usr/local/bin/node";
  platform = "linux";
  arch = "x64";
  version = "v22.23.0";
  versions = Object.freeze({
    node: "22.23.0",
    v8: "browser",
    uv: "browser"
  });
  release = Object.freeze({
    name: "node",
    sourceUrl: "",
    headersUrl: ""
  });
  stdin = Object.freeze({ isTTY: false });
  stdout = Object.freeze({ isTTY: false, write: (chunk: unknown, encodingOrCallback?: ProcessWriteEncoding | ProcessWriteCallback, callback?: ProcessWriteCallback) => this.#write("stdout", chunk, encodingOrCallback, callback) });
  stderr = Object.freeze({ isTTY: false, write: (chunk: unknown, encodingOrCallback?: ProcessWriteEncoding | ProcessWriteCallback, callback?: ProcessWriteCallback) => this.#write("stderr", chunk, encodingOrCallback, callback) });
  #cwd: string;
  #exitMode: ProcessExitMode;

  constructor(options: ProcessBuiltinOptions = {}) {
    super();
    this.argv = options.argv || ["node"];
    this.env = { ...(options.env || {}) };
    this.exitCode = undefined;
    this.#cwd = options.cwd || "/workspace";
    this.#exitMode = options.exitMode || "throw";
  }

  cwd(): string {
    return this.#cwd;
  }

  chdir(path: string): void {
    if (!path.startsWith("/")) this.#cwd = `${this.#cwd}/${path}`;
    else this.#cwd = path;
  }

  exit(code = 0): never | undefined {
    this.exitCode = code;
    this.emit("exit", code);
    if (this.#exitMode === "capture") return undefined;
    throw new Error(`process.exit(${code})`);
  }

  nextTick(callback: (...args: unknown[]) => void, ...args: unknown[]): void {
    queueMicrotask(() => callback(...args));
  }

  uptime(): number {
    return 0;
  }

  #write(event: "stdout" | "stderr", chunk: unknown, encodingOrCallback?: ProcessWriteEncoding | ProcessWriteCallback, callback?: ProcessWriteCallback): boolean {
    this.emit(event, chunk);
    const writeCallback = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
    writeCallback?.();
    return true;
  }
}

export const processBuiltin = new BrowserProcess();
