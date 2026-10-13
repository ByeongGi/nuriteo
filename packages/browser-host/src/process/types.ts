export type HostProcessStatus = "prepared" | "starting" | "ready" | "stopping" | "failed" | "exited" | "killed";
export type HostProcessOutputStream = "stdout" | "stderr";

export interface HostProcessEnv {
  [key: string]: string;
}

export interface HostProcessPrepareOptions {
  parent?: number | null;
  cwd?: string;
  env?: HostProcessEnv;
  argv?: string[];
  projectId?: string;
  terminalMode?: Partial<HostProcessTerminalMode>;
  url?: string | URL | undefined;
}

export interface HostProcessTerminalMode {
  canonical: boolean;
  echo: boolean;
  signals: boolean;
}

export interface HostProcessRecord {
  pid: number;
  generation: number;
  parent: number | null;
  cwd: string;
  env: HostProcessEnv;
  argv: string[];
  projectId?: string;
  url?: string | URL | undefined;
  status: HostProcessStatus;
  exitCode: number | null;
  error?: string | null;
  output: HostProcessOutputChunk[];
  stdout: string;
  stderr: string;
  outputBytes: number;
  outputDroppedBytes: number;
  stdinPendingBytes: number;
  signal: HostProcessSignal | null;
  terminalMode: HostProcessTerminalMode;
  terminalSize: HostProcessResize;
  waiters: Array<(snapshot: HostProcessSnapshot) => void>;
  resourcesReleased: boolean;
  cleanup?: () => void;
  signalTimer?: ReturnType<typeof setTimeout>;
}

export interface HostProcessSnapshot {
  pid: number;
  generation: number;
  parent: number | null;
  cwd: string;
  env: HostProcessEnv;
  argv: string[];
  projectId?: string;
  status: HostProcessStatus;
  exitCode: number | null;
  error: string | null;
  stdout: string;
  stderr: string;
  outputBytes: number;
  outputDroppedBytes: number;
  stdinPendingBytes: number;
  signal: HostProcessSignal | null;
  terminalMode: HostProcessTerminalMode;
  terminalSize: HostProcessResize;
  resourcesReleased: boolean;
}

export type HostProcessSignal = "SIGINT" | "SIGTERM" | "SIGKILL";

export interface HostProcessResize {
  cols: number;
  rows: number;
}

export interface HostProcessTerminalControl {
  size: HostProcessResize;
  onInput(listener: (data: string) => void): () => void;
  onResize(listener: (size: HostProcessResize) => void): () => void;
}

export interface HostProcessOutputChunk {
  pid: number;
  generation: number;
  stream: HostProcessOutputStream;
  data: string;
  at: number;
}

export interface HostWorkerLike {
  addEventListener?: (type: "message" | "error", listener: (event: Event) => void) => void;
  removeEventListener?: (type: "message" | "error", listener: (event: Event) => void) => void;
  postMessage?: (message: unknown) => void;
  terminate: () => void;
}

export type HostWorkerFactory = (record: HostProcessRecord) => HostWorkerLike;

export interface HostProcessTableOptions {
  registry?: import("./worker-registry.ts").WorkerRegistry;
  workerFactory?: HostWorkerFactory;
  permissions?: import("../security/index.ts").PermissionManager;
  abusePolicy?: import("../security/abuse-limits.ts").AbuseLimitPolicy;
  trace?: import("../observability/index.ts").RuntimeTraceSink;
  now?: () => number;
  onOutput?: (chunk: HostProcessOutputChunk) => void;
  maxOutputBytes?: number;
  maxOutputChunks?: number;
  stdinWindowBytes?: number;
  startupTimeoutMs?: number;
  signalGraceMs?: number;
  workerInitialization?: {
    systemWasmUrl: string | URL;
  };
}

export interface HostProcessShellCommandOptions {
  cwd?: string;
  projectId?: string;
  table: import("./spawn.ts").HostProcessTable;
  url: string | URL;
  waitForExit?: boolean;
  releaseOnExit?: boolean;
  terminalMode?: Partial<HostProcessTerminalMode>;
}

export interface HostProcessShellCommandContext {
  argv: string[];
  cwd: string;
  env: HostProcessEnv;
  stdin: string;
  output?: (chunk: { stream: HostProcessOutputStream; data: string }) => void;
  signal?: AbortSignal;
  terminal?: HostProcessTerminalControl;
}

export interface HostProcessShellCommandResult {
  argv: string[];
  exitCode: number;
  stderr: string;
  stdout: string;
  outputTruncatedBytes?: number;
}

export type HostProcessShellCommand = (
  context: HostProcessShellCommandContext
) => HostProcessShellCommandResult | Promise<HostProcessShellCommandResult>;
