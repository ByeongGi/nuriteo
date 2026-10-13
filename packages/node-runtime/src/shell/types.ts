import type { RuntimeEnv } from "../types.ts";

export interface ShellCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  argv?: string[];
  outputTruncatedBytes?: number;
}

export interface ShellCommandContext {
  argv: string[];
  cwd: string;
  env: RuntimeEnv;
  stdin: string;
  files: Map<string, string>;
  output?: ShellOutputSink;
  signal?: AbortSignal;
  terminal?: ShellTerminalControl;
}

export type ShellCommand = (context: ShellCommandContext) => ShellCommandResult | Promise<ShellCommandResult>;
export type ShellCommandMap = Record<string, ShellCommand>;

export interface ShellCommandRegistry {
  resolve(name: string, env?: RuntimeEnv, cwd?: string): ShellCommand;
}

export type ShellOp = "&&" | "|" | null;

export interface ShellStep {
  op: ShellOp;
  argv: string[];
}

export interface ShellRuntimeOptions {
  cwd?: string;
  env?: RuntimeEnv;
  files?: Record<string, string>;
  commands?: ShellCommandMap;
  maxOutputBytes?: number;
  maxInputChunkBytes?: number;
}

export interface ShellRunOptions {
  onOutput?: ShellOutputSink;
  signal?: AbortSignal;
  terminal?: ShellTerminalControl;
}

export interface ShellTerminalSize {
  cols: number;
  rows: number;
}

export interface ShellTerminalControl {
  size: ShellTerminalSize;
  onInput(listener: (data: string) => void): () => void;
  onResize(listener: (size: ShellTerminalSize) => void): () => void;
}

export type ShellOutputStream = "stdout" | "stderr";

export interface ShellOutputChunk {
  stream: ShellOutputStream;
  data: string;
}

export type ShellOutputSink = (chunk: ShellOutputChunk) => void;

export interface ShellRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  files: Record<string, string>;
  outputTruncatedBytes?: number;
}
