import { EventEmitter } from "./events.ts";

export interface ProcessBuiltinOptions {
  argv?: string[];
  cwd?: string;
  env?: Record<string, string>;
}

export class BrowserProcess extends EventEmitter {
  argv: string[];
  env: Record<string, string>;
  exitCode: number | undefined;
  platform = "linux";
  arch = "x64";
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
  stdout = Object.freeze({ isTTY: false, write: (chunk: unknown) => { this.emit("stdout", chunk); return true; } });
  stderr = Object.freeze({ isTTY: false, write: (chunk: unknown) => { this.emit("stderr", chunk); return true; } });
  #cwd: string;

  constructor(options: ProcessBuiltinOptions = {}) {
    super();
    this.argv = options.argv || ["node"];
    this.env = { ...(options.env || {}) };
    this.exitCode = undefined;
    this.#cwd = options.cwd || "/workspace";
  }

  cwd(): string {
    return this.#cwd;
  }

  chdir(path: string): void {
    if (!path.startsWith("/")) this.#cwd = `${this.#cwd}/${path}`;
    else this.#cwd = path;
  }

  exit(code = 0): never {
    this.exitCode = code;
    throw new Error(`process.exit(${code})`);
  }

  nextTick(callback: (...args: unknown[]) => void, ...args: unknown[]): void {
    queueMicrotask(() => callback(...args));
  }

  uptime(): number {
    return 0;
  }
}

export const processBuiltin = new BrowserProcess();
