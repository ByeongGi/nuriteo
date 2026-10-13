import { ShellRuntime, createShellRuntime } from "./runtime.ts";
import type { ShellRunResult, ShellRuntimeOptions, ShellTerminalControl, ShellTerminalSize } from "./types.ts";

export type TerminalEntryStatus = "running" | "completed" | "cancelled";

export interface TerminalSessionOptions extends ShellRuntimeOptions {
  now?: () => number;
  onChunk?: (chunk: TerminalOutputChunk) => void;
}

export interface TerminalOutputChunk {
  entryId: number;
  stream: "stdout" | "stderr";
  data: string;
}

export interface TerminalTranscriptEntry {
  id: number;
  command: string;
  cwd: string;
  exitCode: number | null;
  finishedAt: number | null;
  startedAt: number;
  status: TerminalEntryStatus;
  stderr: string;
  stdout: string;
  outputTruncatedBytes: number;
}

export interface TerminalRunResult extends ShellRunResult {
  entry: TerminalTranscriptEntry;
}

export interface TerminalSessionSnapshot {
  activeEntry: TerminalTranscriptEntry | null;
  cwd: string;
  env: Record<string, string>;
  size: ShellTerminalSize;
}

export class TerminalSession {
  #active: { controller: AbortController; entry: TerminalTranscriptEntry; signal: string | null } | null = null;
  #nextId = 1;
  #now: () => number;
  #onChunk: ((chunk: TerminalOutputChunk) => void) | null;
  #runtime: ShellRuntime;
  #runtimeOptions: ShellRuntimeOptions;
  #transcript: TerminalTranscriptEntry[] = [];
  #inputListeners = new Set<(data: string) => void>();
  #resizeListeners = new Set<(size: ShellTerminalSize) => void>();
  #size: ShellTerminalSize = { cols: 80, rows: 24 };
  #maxOutputBytes: number;
  #maxInputChunkBytes: number;

  constructor(options: TerminalSessionOptions = {}) {
    const { now, onChunk, ...runtimeOptions } = options;
    this.#now = now || Date.now;
    this.#onChunk = onChunk || null;
    this.#runtimeOptions = cloneRuntimeOptions(runtimeOptions);
    this.#runtime = createShellRuntime(this.#runtimeOptions);
    this.#maxOutputBytes = positiveLimit(runtimeOptions.maxOutputBytes, 1024 * 1024, "maxOutputBytes");
    this.#maxInputChunkBytes = positiveLimit(runtimeOptions.maxInputChunkBytes, 64 * 1024, "maxInputChunkBytes");
  }

  get activeEntry(): TerminalTranscriptEntry | null {
    return this.#active?.entry || null;
  }

  history(): string[] {
    return this.#transcript.map((entry) => entry.command);
  }

  transcript(): TerminalTranscriptEntry[] {
    return this.#transcript.map(cloneEntry);
  }

  snapshot(): TerminalSessionSnapshot {
    return {
      activeEntry: this.activeEntry ? cloneEntry(this.activeEntry) : null,
      cwd: this.#runtime.cwd,
      env: { ...this.#runtime.env },
      size: { ...this.#size }
    };
  }

  write(data: string): boolean {
    if (!this.#active) return false;
    if (new TextEncoder().encode(data).byteLength > this.#maxInputChunkBytes) return false;
    for (const listener of this.#inputListeners) listener(data);
    return true;
  }

  resize(cols: number, rows: number): ShellTerminalSize {
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1) {
      throw new RangeError("terminal size must use positive integer columns and rows");
    }
    this.#size = { cols, rows };
    for (const listener of this.#resizeListeners) listener({ ...this.#size });
    return { ...this.#size };
  }

  async run(command: string): Promise<TerminalRunResult> {
    if (this.#active) throw new Error("terminal command already running");
    const controller = new AbortController();
    const entry = this.#createEntry(command);
    this.#active = { controller, entry, signal: null };
    this.#transcript.push(entry);
    const streamedOutput = { stdout: false, stderr: false };

    try {
      const result = await this.#runtime.run(command, {
        onOutput: (chunk) => {
          streamedOutput[chunk.stream] = true;
          appendEntryOutput(entry, chunk.stream, chunk.data, this.#maxOutputBytes);
          this.#onChunk?.({ entryId: entry.id, ...chunk });
        },
        signal: controller.signal,
        terminal: this.#terminalControl()
      });
      if (!streamedOutput.stdout) entry.stdout = result.stdout;
      if (!streamedOutput.stderr) entry.stderr = result.stderr;
      entry.exitCode = result.exitCode;
      entry.outputTruncatedBytes = Math.max(entry.outputTruncatedBytes, result.outputTruncatedBytes || 0);
      entry.status = controller.signal.aborted || result.exitCode === 130 ? "cancelled" : "completed";
      if (!streamedOutput.stdout && !streamedOutput.stderr) this.#emitOutput(entry);
      return { ...result, entry: cloneEntry(entry) };
    } catch (error) {
      entry.stderr = error instanceof Error ? `${error.message}\n` : `${String(error)}\n`;
      entry.exitCode = 1;
      entry.status = controller.signal.aborted ? "cancelled" : "completed";
      if (!streamedOutput.stdout && !streamedOutput.stderr) this.#emitOutput(entry);
      throw error;
    } finally {
      entry.finishedAt = this.#now();
      this.#active = null;
    }
  }

  cancel(entryId = this.#active?.entry.id): boolean {
    if (!this.#active || entryId !== this.#active.entry.id) return false;
    this.#active.signal = "SIGINT";
    this.#active.controller.abort("SIGINT");
    return true;
  }

  signal(signal: "SIGINT" | "SIGTERM" | "SIGKILL" = "SIGTERM"): boolean {
    if (!this.#active) return false;
    this.#active.signal = signal;
    this.#active.controller.abort(signal);
    return true;
  }

  kill(): boolean {
    return this.signal("SIGKILL");
  }

  restart(): void {
    this.cancel();
    this.#runtime = createShellRuntime(this.#runtimeOptions);
  }

  #createEntry(command: string): TerminalTranscriptEntry {
    return {
      id: this.#nextId++,
      command,
      cwd: this.#runtime.cwd,
      exitCode: null,
      finishedAt: null,
      startedAt: this.#now(),
      status: "running",
      stderr: "",
      stdout: "",
      outputTruncatedBytes: 0
    };
  }

  #emitOutput(entry: TerminalTranscriptEntry): void {
    if (!this.#onChunk) return;
    if (entry.stdout) this.#onChunk({ entryId: entry.id, stream: "stdout", data: entry.stdout });
    if (entry.stderr) this.#onChunk({ entryId: entry.id, stream: "stderr", data: entry.stderr });
  }

  #terminalControl(): ShellTerminalControl {
    return {
      size: { ...this.#size },
      onInput: (listener) => {
        this.#inputListeners.add(listener);
        return () => this.#inputListeners.delete(listener);
      },
      onResize: (listener) => {
        this.#resizeListeners.add(listener);
        return () => this.#resizeListeners.delete(listener);
      }
    };
  }
}

export function createTerminalSession(options: TerminalSessionOptions = {}): TerminalSession {
  return new TerminalSession(options);
}

function cloneRuntimeOptions(options: ShellRuntimeOptions): ShellRuntimeOptions {
  const clone: ShellRuntimeOptions = {};
  if (options.cwd !== undefined) clone.cwd = options.cwd;
  if (options.commands) clone.commands = { ...options.commands };
  if (options.env) clone.env = { ...options.env };
  if (options.files) clone.files = { ...options.files };
  if (options.maxOutputBytes !== undefined) clone.maxOutputBytes = options.maxOutputBytes;
  if (options.maxInputChunkBytes !== undefined) clone.maxInputChunkBytes = options.maxInputChunkBytes;
  return clone;
}

function cloneEntry(entry: TerminalTranscriptEntry): TerminalTranscriptEntry {
  return { ...entry };
}

function appendEntryOutput(
  entry: TerminalTranscriptEntry,
  stream: "stdout" | "stderr",
  data: string,
  maxBytes: number
): void {
  const used = new TextEncoder().encode(entry.stdout).byteLength + new TextEncoder().encode(entry.stderr).byteLength;
  const encoded = new TextEncoder().encode(data);
  const available = Math.max(0, maxBytes - used);
  const retained = new TextDecoder().decode(encoded.slice(0, available));
  if (stream === "stdout") entry.stdout += retained;
  else entry.stderr += retained;
  entry.outputTruncatedBytes += encoded.byteLength - new TextEncoder().encode(retained).byteLength;
}

function positiveLimit(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1) throw new RangeError(`${name} must be a positive safe integer`);
  return resolved;
}
