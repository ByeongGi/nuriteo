import { EventEmitter } from "./events.ts";
import { builtinModules } from "./module.ts";
import { constantsBuiltin } from "./constants.ts";

export type ProcessExitMode = "throw" | "capture";
type ProcessWriteCallback = () => void;
type ProcessWriteEncoding = BufferEncoding | string;

class ProcessReadableStdio extends EventEmitter {
  isTTY: boolean;
  readable = true;
  isRaw = false;

  constructor(isTTY = false) {
    super();
    this.isTTY = isTTY;
  }

  pause(): this {
    return this;
  }

  ref(): this {
    return this;
  }

  resume(): this {
    return this;
  }

  setEncoding(_encoding?: BufferEncoding | string): this {
    return this;
  }

  setRawMode(mode: boolean): this {
    this.isRaw = mode;
    return this;
  }

  push(chunk: unknown): boolean {
    if (!this.readable) return false;
    this.emit("data", chunk);
    return true;
  }

  end(): void {
    if (!this.readable) return;
    this.readable = false;
    this.emit("end");
    this.emit("close");
  }

  unref(): this {
    return this;
  }
}

class ProcessWritableStdio extends EventEmitter {
  isTTY: boolean;
  writable = true;
  columns = 80;
  rows = 24;
  #writeChunk: (chunk: unknown) => boolean | void;

  constructor(writeChunk: (chunk: unknown) => boolean | void, isTTY = false) {
    super();
    this.#writeChunk = writeChunk;
    this.isTTY = isTTY;
  }

  write(chunk: unknown, encodingOrCallback?: ProcessWriteEncoding | ProcessWriteCallback, callback?: ProcessWriteCallback): boolean {
    const accepted = this.#writeChunk(chunk);
    this.emit("data", chunk);
    const writeCallback = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
    writeCallback?.();
    return accepted !== false;
  }

  end(chunk?: unknown, callback?: ProcessWriteCallback): this {
    if (chunk !== undefined) this.write(chunk);
    callback?.();
    this.emit("finish");
    return this;
  }

  ref(): this {
    return this;
  }

  unref(): this {
    return this;
  }
}

export interface ProcessBuiltinOptions {
  argv?: string[];
  cwd?: string;
  emitExitInCapture?: boolean;
  env?: Record<string, string>;
  exitMode?: ProcessExitMode;
  pid?: number;
  terminal?: boolean;
  terminalSize?: { cols: number; rows: number };
  writeStdout?: (chunk: unknown) => boolean | void;
  writeStderr?: (chunk: unknown) => boolean | void;
}

export class BrowserProcess extends EventEmitter {
  argv: string[];
  execArgv: string[];
  env: Record<string, string>;
  exitCode: number | undefined;
  pid: number;
  execPath = "/usr/local/bin/node";
  platform = "linux";
  arch = "x64";
  version = "v22.23.0";
  features = Object.freeze({
    cached_builtins: false,
    debug: false,
    inspector: false,
    ipv6: true,
    require_module: true,
    tls: false,
    tls_alpn: false,
    tls_ocsp: false,
    tls_sni: false,
    typescript: false,
    uv: true
  });
  versions = Object.freeze({
    node: "22.23.0",
    v8: "browser",
    uv: "browser",
    webcontainer: "1.0.0"
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
  stdin: ProcessReadableStdio;
  stdout: ProcessWritableStdio;
  stderr: ProcessWritableStdio;
  #cwd: string;
  #emitExitInCapture: boolean;
  #exitMode: ProcessExitMode;
  #umask = 0o022;

  constructor(options: ProcessBuiltinOptions = {}) {
    super();
    this.argv = options.argv || ["node"];
    this.execArgv = [];
    this.env = { ...(options.env || {}) };
    this.exitCode = undefined;
    this.pid = options.pid ?? 1;
    this.#cwd = options.cwd || "/workspace";
    this.#emitExitInCapture = options.emitExitInCapture ?? false;
    this.#exitMode = options.exitMode || "throw";
    const terminal = options.terminal ?? false;
    this.stdin = new ProcessReadableStdio(terminal);
    this.stdout = new ProcessWritableStdio((chunk) => {
      this.emit("stdout", chunk);
      return options.writeStdout?.(chunk);
    }, terminal);
    this.stderr = new ProcessWritableStdio((chunk) => {
      this.emit("stderr", chunk);
      return options.writeStderr?.(chunk);
    }, terminal);
    if (options.terminalSize) this.resizeTerminal(options.terminalSize.cols, options.terminalSize.rows);
  }

  binding(name: string): unknown {
    if (name === "natives") {
      return Object.freeze(Object.fromEntries(
        builtinModules
          .filter((moduleName) => !moduleName.startsWith("node:"))
          .map((moduleName) => [moduleName, ""])
      ));
    }
    if (name === "constants") {
      const errno = Object.freeze({
        EBADF: 9,
        EACCES: constantsBuiltin.EACCES,
        EEXIST: constantsBuiltin.EEXIST,
        EINVAL: constantsBuiltin.EINVAL,
        EISDIR: constantsBuiltin.EISDIR,
        ENOENT: constantsBuiltin.ENOENT,
        ENOTDIR: constantsBuiltin.ENOTDIR,
        EPERM: constantsBuiltin.EPERM,
        EROFS: constantsBuiltin.EROFS
      });
      return Object.freeze({ ...constantsBuiltin, EBADF: errno.EBADF, fs: constantsBuiltin, os: { errno } });
    }
    if (name === "buffer") return Object.freeze({ kStringMaxLength: 0x1fffffe8 });
    const error = new Error(`No such module: ${name}`) as Error & { code?: string };
    error.code = "ERR_UNKNOWN_BUILTIN_MODULE";
    throw error;
  }

  cwd(): string {
    return this.#cwd;
  }

  chdir(path: string): void {
    if (!path.startsWith("/")) this.#cwd = `${this.#cwd}/${path}`;
    else this.#cwd = path;
  }

  hrtime = Object.assign((previous?: [number, number]): [number, number] => {
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
  }, {
    bigint: (): bigint => BigInt(Math.floor(performance.now() * 1_000_000))
  });

  memoryUsage = Object.assign(() => ({
    arrayBuffers: 0,
    external: 0,
    heapTotal: 1_073_741_824,
    heapUsed: 67_108_864,
    rss: 134_217_728
  }), {
    rss: () => 134_217_728
  });

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

  writeStdin(chunk: unknown): boolean {
    return this.stdin.push(chunk);
  }

  endStdin(): void {
    this.stdin.end();
  }

  resizeTerminal(cols: number, rows: number): void {
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1) {
      throw new RangeError("terminal size must use positive integer columns and rows");
    }
    this.stdout.columns = cols;
    this.stdout.rows = rows;
    this.stderr.columns = cols;
    this.stderr.rows = rows;
    this.emit("SIGWINCH");
  }

  notifyDrain(stream: "stdout" | "stderr"): void {
    this[stream].emit("drain");
  }

  signal(signal: "SIGINT" | "SIGTERM" | "SIGKILL"): void {
    this.emit(signal);
    if (this.exitCode === undefined) this.exitCode = signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 137;
  }

  uptime(): number {
    return 0;
  }

  umask(mask?: number): number {
    const previous = this.#umask;
    if (mask !== undefined) this.#umask = mask;
    return previous;
  }

}

export const processBuiltin = new BrowserProcess();
