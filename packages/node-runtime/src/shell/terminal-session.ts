import { ShellRuntime, createShellRuntime } from "./runtime.ts";
import type { ShellRunResult, ShellRuntimeOptions } from "./types.ts";

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
}

export interface TerminalRunResult extends ShellRunResult {
  entry: TerminalTranscriptEntry;
}

export class TerminalSession {
  #active: { controller: AbortController; entry: TerminalTranscriptEntry } | null = null;
  #nextId = 1;
  #now: () => number;
  #onChunk: ((chunk: TerminalOutputChunk) => void) | null;
  #runtime: ShellRuntime;
  #runtimeOptions: ShellRuntimeOptions;
  #transcript: TerminalTranscriptEntry[] = [];

  constructor(options: TerminalSessionOptions = {}) {
    const { now, onChunk, ...runtimeOptions } = options;
    this.#now = now || Date.now;
    this.#onChunk = onChunk || null;
    this.#runtimeOptions = cloneRuntimeOptions(runtimeOptions);
    this.#runtime = createShellRuntime(this.#runtimeOptions);
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

  async run(command: string): Promise<TerminalRunResult> {
    if (this.#active) throw new Error("terminal command already running");
    const controller = new AbortController();
    const entry = this.#createEntry(command);
    this.#active = { controller, entry };
    this.#transcript.push(entry);

    try {
      const result = await this.#runtime.run(command, { signal: controller.signal });
      entry.stdout = result.stdout;
      entry.stderr = result.stderr;
      entry.exitCode = result.exitCode;
      entry.status = controller.signal.aborted || result.exitCode === 130 ? "cancelled" : "completed";
      return { ...result, entry: cloneEntry(entry) };
    } catch (error) {
      entry.stderr = error instanceof Error ? `${error.message}\n` : `${String(error)}\n`;
      entry.exitCode = 1;
      entry.status = controller.signal.aborted ? "cancelled" : "completed";
      throw error;
    } finally {
      entry.finishedAt = this.#now();
      this.#active = null;
      this.#emitOutput(entry);
    }
  }

  cancel(entryId = this.#active?.entry.id): boolean {
    if (!this.#active || entryId !== this.#active.entry.id) return false;
    this.#active.controller.abort();
    return true;
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
      stdout: ""
    };
  }

  #emitOutput(entry: TerminalTranscriptEntry): void {
    if (!this.#onChunk) return;
    if (entry.stdout) this.#onChunk({ entryId: entry.id, stream: "stdout", data: entry.stdout });
    if (entry.stderr) this.#onChunk({ entryId: entry.id, stream: "stderr", data: entry.stderr });
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
  return clone;
}

function cloneEntry(entry: TerminalTranscriptEntry): TerminalTranscriptEntry {
  return { ...entry };
}
