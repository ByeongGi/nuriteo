import { EventEmitter } from "./events.ts";
import { Readable, Writable } from "./stream.ts";

export class UnsupportedChildProcessError extends Error {
  code = "ERR_BROWSER_CHILD_PROCESS_UNSUPPORTED";

  constructor(command: string) {
    super(`External child process execution is not available in the browser runtime: ${command}`);
    this.name = "UnsupportedChildProcessError";
  }
}

export interface SpawnOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  shell?: boolean | string;
  stdio?: "pipe" | "ignore" | "inherit" | readonly unknown[];
}

export class ChildProcess extends EventEmitter {
  exitCode: number | null = null;
  signalCode: string | null = null;
  killed = false;
  pid = 0;
  stdin = new Writable();
  stdout = new Readable();
  stderr = new Readable();
  stdio = [this.stdin, this.stdout, this.stderr] as const;

  kill(signal = "SIGTERM"): boolean {
    if (this.killed || this.exitCode !== null || this.signalCode !== null) return false;
    this.killed = true;
    this.signalCode = signal;
    this.emit("exit", null, signal);
    this.emit("close", null, signal);
    return true;
  }
}

export function spawn(command: string, _args: readonly string[] = [], _options: SpawnOptions = {}): ChildProcess {
  const child = new ChildProcess();
  queueMicrotask(() => {
    child.emit("error", new UnsupportedChildProcessError(command));
    child.exitCode = 1;
    child.emit("close", 1, null);
  });
  return child;
}

export function execFile(
  file: string,
  argsOrCallback?: readonly string[] | ExecCallback,
  _optionsOrCallback?: SpawnOptions | ExecCallback,
  maybeCallback?: ExecCallback
): ChildProcess {
  const callback = typeof argsOrCallback === "function"
    ? argsOrCallback
    : typeof _optionsOrCallback === "function"
      ? _optionsOrCallback
      : maybeCallback;
  const child = spawn(file, Array.isArray(argsOrCallback) ? argsOrCallback : []);
  if (callback) {
    child.once("error", (error) => callback(error as Error, "", ""));
  }
  return child;
}

export function exec(command: string, callback?: ExecCallback): ChildProcess {
  return execFile(command, [], callback);
}

export function spawnSync(command: string): SpawnSyncResult {
  return {
    error: new UnsupportedChildProcessError(command),
    pid: 0,
    signal: null,
    status: 1,
    stderr: new Uint8Array(),
    stdout: new Uint8Array()
  };
}

export function execFileSync(file: string): never {
  throw new UnsupportedChildProcessError(file);
}

export function execSync(command: string): never {
  throw new UnsupportedChildProcessError(command);
}

export interface SpawnSyncResult {
  error: Error;
  pid: number;
  signal: string | null;
  status: number;
  stderr: Uint8Array;
  stdout: Uint8Array;
}

export type ExecCallback = (error: Error | null, stdout: string | Uint8Array, stderr: string | Uint8Array) => void;

export const childProcessBuiltin = Object.freeze({
  ChildProcess,
  exec,
  execFile,
  execFileSync,
  execSync,
  spawn,
  spawnSync
});
