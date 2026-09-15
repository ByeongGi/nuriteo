import { EventEmitter } from "./events.ts";

export type ProcessExitMode = "throw" | "capture";
type ProcessWriteCallback = () => void;
type ProcessWriteEncoding = BufferEncoding | string;

export interface ProcessBuiltinOptions {
  argv?: string[];
  cwd?: string;
  emitExitInCapture?: boolean;
  env?: Record<string, string>;
  exitMode?: ProcessExitMode;
  pid?: number;
}

export class BrowserProcess extends EventEmitter {
  argv: string[];
  env: Record<string, string>;
  exitCode: number | undefined;
  pid: number;
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
  report = {
    excludeNetwork: false,
    getReport: () => ({
      header: {
        arch: this.arch,
        glibcVersionRuntime: undefined,
        nodejsVersion: this.version,
        platform: this.platform
      },
      sharedObjects: []
    })
  };
  stdin = Object.freeze({ isTTY: false });
  stdout = Object.freeze({ isTTY: false, write: (chunk: unknown, encodingOrCallback?: ProcessWriteEncoding | ProcessWriteCallback, callback?: ProcessWriteCallback) => this.#write("stdout", chunk, encodingOrCallback, callback) });
  stderr = Object.freeze({ isTTY: false, write: (chunk: unknown, encodingOrCallback?: ProcessWriteEncoding | ProcessWriteCallback, callback?: ProcessWriteCallback) => this.#write("stderr", chunk, encodingOrCallback, callback) });
  #cwd: string;
  #emitExitInCapture: boolean;
  #exitMode: ProcessExitMode;
  #umask = 0o022;

  constructor(options: ProcessBuiltinOptions = {}) {
    super();
    this.argv = options.argv || ["node"];
    this.env = { ...(options.env || {}) };
    this.exitCode = undefined;
    this.pid = options.pid ?? 1;
    this.#cwd = options.cwd || "/workspace";
    this.#emitExitInCapture = options.emitExitInCapture ?? false;
    this.#exitMode = options.exitMode || "throw";
  }

  cwd(): string {
    return this.#cwd;
  }

  chdir(path: string): void {
    if (!path.startsWith("/")) this.#cwd = `${this.#cwd}/${path}`;
    else this.#cwd = path;
  }

  hrtime(previous?: [number, number]): [number, number] {
    const now = performance.now();
    const seconds = Math.floor(now / 1000);
    const nanoseconds = Math.floor((now - seconds * 1000) * 1_000_000);
    if (!previous) return [seconds, nanoseconds];
    let diffSeconds = seconds - previous[0];
    let diffNanoseconds = nanoseconds - previous[1];
    if (diffNanoseconds < 0) {
      diffSeconds -= 1;
      diffNanoseconds += 1_000_000_000;
    }
    return [diffSeconds, diffNanoseconds];
  }

  exit(code = 0): never | undefined {
    this.exitCode = code;
    if (this.#exitMode === "capture") {
      if (this.#emitExitInCapture) this.emit("exit", code);
      return undefined;
    }
    this.emit("exit", code);
    throw new Error(`process.exit(${code})`);
  }

  nextTick(callback: (...args: unknown[]) => void, ...args: unknown[]): void {
    queueMicrotask(() => callback(...args));
  }

  uptime(): number {
    return 0;
  }

  umask(mask?: number): number {
    const previous = this.#umask;
    if (mask !== undefined) this.#umask = mask;
    return previous;
  }

  #write(event: "stdout" | "stderr", chunk: unknown, encodingOrCallback?: ProcessWriteEncoding | ProcessWriteCallback, callback?: ProcessWriteCallback): boolean {
    this.emit(event, chunk);
    const writeCallback = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
    writeCallback?.();
    return true;
  }
}

export const processBuiltin = new BrowserProcess();
