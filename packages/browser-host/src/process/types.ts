export type HostProcessStatus = "prepared" | "starting" | "ready" | "failed" | "exited" | "killed";
export type HostProcessOutputStream = "stdout" | "stderr";

export interface HostProcessEnv {
  [key: string]: string;
}

export interface HostProcessPrepareOptions {
  parent?: number | null;
  cwd?: string;
  env?: HostProcessEnv;
  projectId?: string;
  url?: string | URL | undefined;
}

export interface HostProcessRecord {
  pid: number;
  generation: number;
  parent: number | null;
  cwd: string;
  env: HostProcessEnv;
  projectId?: string;
  url?: string | URL | undefined;
  status: HostProcessStatus;
  exitCode: number | null;
  error?: string | null;
  output: HostProcessOutputChunk[];
  stdout: string;
  stderr: string;
  waiters: Array<(snapshot: HostProcessSnapshot) => void>;
  resourcesReleased: boolean;
  cleanup?: () => void;
}

export interface HostProcessSnapshot {
  pid: number;
  generation: number;
  parent: number | null;
  cwd: string;
  env: HostProcessEnv;
  projectId?: string;
  status: HostProcessStatus;
  exitCode: number | null;
  error: string | null;
  stdout: string;
  stderr: string;
  resourcesReleased: boolean;
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
}

export interface HostProcessShellCommandOptions {
  cwd?: string;
  projectId?: string;
  table: import("./spawn.ts").HostProcessTable;
  url: string | URL;
  waitForExit?: boolean;
}

export interface HostProcessShellCommandContext {
  argv: string[];
  cwd: string;
  env: HostProcessEnv;
  stdin: string;
  output?: (chunk: { stream: HostProcessOutputStream; data: string }) => void;
  signal?: AbortSignal;
}

export interface HostProcessShellCommandResult {
  argv: string[];
  exitCode: number;
  stderr: string;
  stdout: string;
}

export type HostProcessShellCommand = (
  context: HostProcessShellCommandContext
) => HostProcessShellCommandResult | Promise<HostProcessShellCommandResult>;
