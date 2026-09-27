import { BrowserProcess } from "../../../node-runtime/src/builtins/process.ts";
import type { HostProcessTerminalMode } from "./types.ts";
import type { VirtualPtyWriteResult } from "./virtual-pty.ts";

export type ProcessWorkerSignal = "SIGINT" | "SIGTERM" | "SIGKILL";

export interface ProcessWorkerStartMessage {
  type: "start";
  pid: number;
  generation: number;
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  terminalMode: HostProcessTerminalMode;
  terminal: { cols: number; rows: number };
  outputWindowBytes: number;
  stdinWindowBytes: number;
}

export type ProcessWorkerControlMessage =
  | ProcessWorkerStartMessage
  | { type: "stdin"; pid: number; generation: number; data: string; bytes: number }
  | { type: "resize"; pid: number; generation: number; cols: number; rows: number }
  | { type: "signal"; pid: number; generation: number; signal: ProcessWorkerSignal }
  | { type: "output-ack"; pid: number; generation: number; bytes: number };

export interface ProcessWorkerRuntimeOptions {
  createVirtualPty?: (mode: HostProcessTerminalMode, size: { cols: number; rows: number }) => ProcessWorkerVirtualPty;
  postMessage(message: unknown): void;
}

export interface ProcessWorkerVirtualPty {
  close(exitCode?: number): void;
  resize(size: { cols: number; rows: number }): void;
  write(data: string): VirtualPtyWriteResult;
  writeOutput(data: string): { output: string };
}

interface OutputWaiter {
  bytes: Uint8Array;
  offset: number;
  resolve(): void;
  stream: "stdout" | "stderr";
}

interface ActiveProcess {
  abort: AbortController;
  generation: number;
  output: ProcessOutputWindow;
  pid: number;
  process: BrowserProcess;
  stdinChain: Promise<void>;
  stdinDrain: Promise<void>;
  stdinWindowBytes: number;
  terminalMode: HostProcessTerminalMode;
  virtualPty: ProcessWorkerVirtualPty | null;
  canonicalInput: string;
  finished: boolean;
}

const MAX_PROTOCOL_BYTES = 64 * 1024;
const MAX_ARGV_ENTRIES = 256;
const OUTPUT_CHUNK_BYTES = 16 * 1024;
const NODE_VERSION = "v22.23.0";

export function createProcessWorkerRuntime(options: ProcessWorkerRuntimeOptions): {
  handleMessage(message: unknown): boolean;
} {
  let active: ActiveProcess | null = null;

  const finish = (entry: ActiveProcess, code: number): void => {
    if (entry.finished) return;
    entry.finished = true;
    entry.virtualPty?.close(code);
    options.postMessage({
      type: "exit",
      pid: entry.pid,
      generation: entry.generation,
      code
    });
    if (active === entry) active = null;
  };

  const start = (message: ProcessWorkerStartMessage): void => {
    if (active && !active.finished) {
      failStart(options, message, "process worker already has an active process");
      return;
    }

    let validated: ReturnType<typeof validateStartMessage>;
    try {
      validated = validateStartMessage(message);
    } catch (error) {
      failStart(options, message, error instanceof Error ? error.message : String(error));
      return;
    }

    const abort = new AbortController();
    const output = new ProcessOutputWindow({
      generation: validated.generation,
      maxOutstandingBytes: validated.outputWindowBytes,
      pid: validated.pid,
      postMessage: options.postMessage
    });
    const process = new BrowserProcess({
      argv: [...validated.argv],
      cwd: validated.cwd,
      env: { ...validated.env },
      exitMode: "capture",
      pid: validated.pid,
      terminal: true,
      terminalSize: validated.terminal
    });
    let virtualPty: ProcessWorkerVirtualPty | null;
    try {
      virtualPty = options.createVirtualPty?.(validated.terminalMode, validated.terminal) || null;
    } catch (error) {
      failStart(options, message, error instanceof Error ? error.message : String(error));
      return;
    }
    const entry: ActiveProcess = {
      abort,
      generation: validated.generation,
      output,
      pid: validated.pid,
      process,
      stdinChain: Promise.resolve(),
      stdinDrain: Promise.resolve(),
      stdinWindowBytes: validated.stdinWindowBytes,
      terminalMode: { ...validated.terminalMode },
      virtualPty,
      canonicalInput: "",
      finished: false
    };
    active = entry;

    options.postMessage({
      type: "ready",
      pid: entry.pid,
      generation: entry.generation
    });

    void executeArgv(entry).then(
      (code) => finish(entry, code),
      async (error) => {
        await output.write("stderr", `${error instanceof Error ? error.message : String(error)}\n`);
        finish(entry, errorCode(error));
      }
    );
  };

  const handleMessage = (value: unknown): boolean => {
    if (!isRecord(value) || typeof value.type !== "string") return false;
    if (value.type === "start") {
      start(value as unknown as ProcessWorkerStartMessage);
      return true;
    }
    if (value.type !== "stdin" && value.type !== "resize" && value.type !== "signal" && value.type !== "output-ack") {
      return false;
    }
    if (!active || value.pid !== active.pid || value.generation !== active.generation || active.finished) return true;

    if (value.type === "output-ack") {
      active.output.ack(nonNegativeInteger(value.bytes));
      return true;
    }
    if (value.type === "resize") {
      const size = {
        cols: positiveInteger(value.cols, "terminal columns"),
        rows: positiveInteger(value.rows, "terminal rows")
      };
      active.virtualPty?.resize(size);
      active.process.resizeTerminal(size.cols, size.rows);
      return true;
    }
    if (value.type === "signal") {
      if (value.signal !== "SIGINT" && value.signal !== "SIGTERM" && value.signal !== "SIGKILL") return true;
      active.process.signal(value.signal);
      active.abort.abort(value.signal);
      finish(active, signalExitCode(value.signal));
      return true;
    }

    const data = typeof value.data === "string" ? value.data : "";
    const bytes = byteLength(data);
    if (bytes === 0 || bytes > active.stdinWindowBytes || value.bytes !== bytes) return true;
    const entry = active;
    entry.stdinChain = entry.stdinChain
      .then(async () => {
        if (entry.finished) return;
        const signal = await writeTerminalInput(entry, data);
        await entry.stdinDrain;
        options.postMessage({
          type: "stdin-ack",
          pid: entry.pid,
          generation: entry.generation,
          bytes
        });
        if (signal && !entry.finished) {
          entry.process.signal(signal);
          entry.abort.abort(signal);
          finish(entry, signalExitCode(signal));
        }
      })
      .catch(async (error) => {
        if (entry.finished) return;
        await entry.output.write("stderr", `${error instanceof Error ? error.message : String(error)}\n`);
        finish(entry, 1);
      });
    return true;
  };

  return { handleMessage };
}

async function writeTerminalInput(entry: ActiveProcess, data: string): Promise<ProcessWorkerSignal | null> {
  if (entry.virtualPty) {
    const result = entry.virtualPty.write(data);
    if (result.echo) await entry.output.write("stdout", result.echo);
    if (result.input) entry.process.writeStdin(result.input);
    if (result.eof) entry.process.endStdin();
    return result.interrupt ? "SIGINT" : null;
  }
  if (!entry.terminalMode.canonical) {
    if (entry.terminalMode.echo) await entry.output.write("stdout", data);
    entry.process.writeStdin(data);
    return null;
  }

  for (const input of data) {
    if (entry.terminalMode.signals && input === "\x03") {
      entry.canonicalInput = "";
      if (entry.terminalMode.echo) await entry.output.write("stdout", "^C\n");
      return "SIGINT";
    }
    if (input === "\x04") {
      if (entry.canonicalInput) flushCanonicalInput(entry);
      else entry.process.endStdin();
      continue;
    }
    if (input === "\x7f" || input === "\b") {
      const characters = Array.from(entry.canonicalInput);
      if (characters.length > 0) {
        characters.pop();
        entry.canonicalInput = characters.join("");
        if (entry.terminalMode.echo) await entry.output.write("stdout", "\b \b");
      }
      continue;
    }
    if (input === "\x15") {
      const erased = Array.from(entry.canonicalInput).length;
      entry.canonicalInput = "";
      if (entry.terminalMode.echo && erased > 0) await entry.output.write("stdout", "\b \b".repeat(erased));
      continue;
    }

    const normalized = input === "\r" ? "\n" : input;
    if (byteLength(entry.canonicalInput) + byteLength(normalized) > entry.stdinWindowBytes) {
      if (entry.terminalMode.echo) await entry.output.write("stdout", "\x07");
      continue;
    }
    entry.canonicalInput += normalized;
    if (entry.terminalMode.echo) await entry.output.write("stdout", normalized);
    if (normalized === "\n") flushCanonicalInput(entry);
  }
  return null;
}

function flushCanonicalInput(entry: ActiveProcess): void {
  const input = entry.canonicalInput;
  entry.canonicalInput = "";
  if (input) entry.process.writeStdin(input);
}

async function executeArgv(entry: ActiveProcess): Promise<number> {
  const [command, ...args] = entry.process.argv;
  switch (command) {
    case "echo":
    case "/bin/echo":
      await writeProcessStdout(entry, `${args.join(" ")}\n`);
      return 0;
    case "pwd":
    case "/bin/pwd":
      if (args.length > 0) return usageError(entry, "pwd: arguments are not supported");
      await writeProcessStdout(entry, `${entry.process.cwd()}\n`);
      return 0;
    case "env":
    case "/usr/bin/env":
      if (args.length > 0) return usageError(entry, "env: command execution is not supported");
      await writeProcessStdout(entry, `${Object.entries(entry.process.env).map(([name, value]) => `${name}=${value}`).join("\n")}\n`);
      return 0;
    case "true":
    case "/bin/true":
      return args.length === 0 ? 0 : usageError(entry, "true: arguments are not supported");
    case "false":
    case "/bin/false":
      return args.length === 0 ? 1 : usageError(entry, "false: arguments are not supported");
    case "node":
    case "/usr/bin/node":
    case "/usr/local/bin/node":
      if (args.length === 1 && (args[0] === "--version" || args[0] === "-v")) {
        await writeProcessStdout(entry, `${NODE_VERSION}\n`);
        return 0;
      }
      return usageError(entry, "node: only --version is allowed by the browser process policy");
    case "cat":
    case "/bin/cat":
      if (args.some((arg) => arg !== "-")) return usageError(entry, "cat: filesystem operands are not supported");
      return runCat(entry);
    case "terminal-size":
      if (args.length > 0 && (args.length !== 1 || args[0] !== "--watch")) {
        return usageError(entry, "terminal-size: only --watch is supported");
      }
      return runTerminalSize(entry, args[0] === "--watch");
    default:
      await entry.output.write("stderr", `${command}: command not found\n`);
      return 127;
  }
}

async function runCat(entry: ActiveProcess): Promise<number> {
  let chain = Promise.resolve();
  const onData = (chunk: unknown): void => {
    const data = typeof chunk === "string" ? chunk : String(chunk);
    chain = chain.then(() => writeProcessStdout(entry, data));
    entry.stdinDrain = chain;
  };
  entry.process.stdin.on("data", onData);
  try {
    await new Promise<void>((resolve) => {
      entry.abort.signal.addEventListener("abort", () => resolve(), { once: true });
      entry.process.stdin.on("end", () => resolve());
    });
    await chain;
    return entry.process.exitCode ?? 0;
  } finally {
    entry.process.stdin.off("data", onData);
  }
}

async function runTerminalSize(entry: ActiveProcess, watch: boolean): Promise<number> {
  let chain = writeProcessStdout(entry, `${entry.process.stdout.columns}x${entry.process.stdout.rows}\n`);
  if (!watch) {
    await chain;
    return 0;
  }
  const onResize = (): void => {
    chain = chain.then(() => writeProcessStdout(entry, `${entry.process.stdout.columns}x${entry.process.stdout.rows}\n`));
  };
  entry.process.on("SIGWINCH", onResize);
  try {
    await new Promise<void>((resolve) => entry.abort.signal.addEventListener("abort", () => resolve(), { once: true }));
    await chain;
    return entry.process.exitCode ?? 0;
  } finally {
    entry.process.off("SIGWINCH", onResize);
  }
}

async function usageError(entry: ActiveProcess, message: string): Promise<number> {
  await entry.output.write("stderr", `${message}\n`);
  return 2;
}

async function writeProcessStdout(entry: ActiveProcess, data: string): Promise<void> {
  const output = entry.virtualPty?.writeOutput(data).output ?? data;
  await entry.output.write("stdout", output);
}

class ProcessOutputWindow {
  readonly #generation: number;
  readonly #maxOutstandingBytes: number;
  readonly #pid: number;
  readonly #postMessage: (message: unknown) => void;
  #outstandingBytes = 0;
  #queue: OutputWaiter[] = [];

  constructor(options: {
    generation: number;
    maxOutstandingBytes: number;
    pid: number;
    postMessage(message: unknown): void;
  }) {
    this.#generation = options.generation;
    this.#maxOutstandingBytes = options.maxOutstandingBytes;
    this.#pid = options.pid;
    this.#postMessage = options.postMessage;
  }

  write(stream: "stdout" | "stderr", data: string): Promise<void> {
    if (!data) return Promise.resolve();
    return new Promise((resolve) => {
      this.#queue.push({ bytes: new TextEncoder().encode(data), offset: 0, resolve, stream });
      this.#flush();
    });
  }

  ack(bytes: number): void {
    this.#outstandingBytes = Math.max(0, this.#outstandingBytes - bytes);
    this.#flush();
  }

  #flush(): void {
    while (this.#queue.length > 0 && this.#outstandingBytes < this.#maxOutstandingBytes) {
      const item = this.#queue[0];
      if (!item) return;
      const available = this.#maxOutstandingBytes - this.#outstandingBytes;
      const size = Math.min(available, OUTPUT_CHUNK_BYTES, item.bytes.byteLength - item.offset);
      if (size < 1) return;
      const chunk = item.bytes.slice(item.offset, item.offset + size);
      item.offset += size;
      this.#outstandingBytes += chunk.byteLength;
      this.#postMessage({
        type: item.stream,
        pid: this.#pid,
        generation: this.#generation,
        data: new TextDecoder().decode(chunk)
      });
      if (item.offset === item.bytes.byteLength) {
        this.#queue.shift();
        item.resolve();
      }
    }
  }
}

function validateStartMessage(message: ProcessWorkerStartMessage): ProcessWorkerStartMessage {
  positiveInteger(message.pid, "process pid");
  positiveInteger(message.generation, "process generation");
  if (!Array.isArray(message.argv) || message.argv.length < 1 || message.argv.length > MAX_ARGV_ENTRIES) {
    throw new Error("process argv must contain between 1 and 256 entries");
  }
  let argvBytes = 0;
  for (const arg of message.argv) {
    if (typeof arg !== "string" || arg.includes("\0")) throw new Error("process argv must contain NUL-free strings");
    argvBytes += byteLength(arg);
  }
  if (argvBytes > MAX_PROTOCOL_BYTES) throw new Error("process argv exceeds 65536 bytes");
  if (typeof message.cwd !== "string" || !message.cwd.startsWith("/") || message.cwd.includes("\0") || message.cwd.split("/").some((part) => part === "." || part === "..")) {
    throw new Error("process cwd must be an absolute normalized path");
  }
  if (!isRecord(message.env)) throw new Error("process env must be an object");
  let envBytes = 0;
  for (const [name, value] of Object.entries(message.env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || typeof value !== "string" || value.includes("\0")) {
      throw new Error(`invalid process environment entry: ${name}`);
    }
    envBytes += byteLength(name) + byteLength(value);
  }
  if (envBytes > MAX_PROTOCOL_BYTES) throw new Error("process environment exceeds 65536 bytes");
  positiveInteger(message.terminal?.cols, "terminal columns");
  positiveInteger(message.terminal?.rows, "terminal rows");
  validateTerminalMode(message.terminalMode);
  positiveInteger(message.outputWindowBytes, "output window");
  positiveInteger(message.stdinWindowBytes, "stdin window");
  return message;
}

function validateTerminalMode(mode: unknown): asserts mode is HostProcessTerminalMode {
  if (!isRecord(mode)
    || typeof mode.canonical !== "boolean"
    || typeof mode.echo !== "boolean"
    || typeof mode.signals !== "boolean") {
    throw new Error("process terminal mode must define canonical, echo, and signals booleans");
  }
}

function failStart(options: ProcessWorkerRuntimeOptions, message: Partial<ProcessWorkerStartMessage>, error: string): void {
  options.postMessage({
    type: "failed",
    ...(typeof message.pid === "number" ? { pid: message.pid } : {}),
    ...(typeof message.generation === "number" ? { generation: message.generation } : {}),
    error
  });
}

function errorCode(error: unknown): number {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "number" ? error.code : 1;
}

function signalExitCode(signal: ProcessWorkerSignal): number {
  return signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 137;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function positiveInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new RangeError(`${name} must be a positive safe integer`);
  return Number(value);
}

function nonNegativeInteger(value: unknown): number {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
