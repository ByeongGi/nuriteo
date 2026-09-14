export type HostProcessStatus = "prepared" | "starting" | "ready" | "failed" | "exited" | "killed";

export interface HostProcessEnv {
  [key: string]: string;
}

export interface HostProcessPrepareOptions {
  parent?: number | null;
  cwd?: string;
  env?: HostProcessEnv;
  url?: string | URL | undefined;
}

export interface HostProcessRecord {
  pid: number;
  generation: number;
  parent: number | null;
  cwd: string;
  env: HostProcessEnv;
  url?: string | URL | undefined;
  status: HostProcessStatus;
  exitCode: number | null;
  error?: string | null;
  waiters: Array<(snapshot: HostProcessSnapshot) => void>;
  resourcesReleased: boolean;
}

export interface HostProcessSnapshot {
  pid: number;
  generation: number;
  parent: number | null;
  cwd: string;
  env: HostProcessEnv;
  status: HostProcessStatus;
  exitCode: number | null;
  error: string | null;
  resourcesReleased: boolean;
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
}
