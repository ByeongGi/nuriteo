import { WorkerRegistry } from "./worker-registry.ts";
import type { HostProcessPrepareOptions, HostProcessRecord, HostProcessSnapshot, HostProcessStatus, HostProcessTableOptions, HostWorkerLike } from "./types.ts";

export class HostProcessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HostProcessError";
  }
}

export class HostProcessTable {
  nextPid: number;
  nextGeneration: number;
  records: Map<number, HostProcessRecord>;
  registry: WorkerRegistry;
  workerFactory: (record: HostProcessRecord) => HostWorkerLike;

  constructor(options: HostProcessTableOptions = {}) {
    this.nextPid = 1;
    this.nextGeneration = 1;
    this.records = new Map();
    this.registry = options.registry || new WorkerRegistry();
    this.workerFactory = options.workerFactory || ((record) => new Worker(record.url as string | URL, { type: "module", name: `process-${record.pid}` }));
  }

  prepare(options: HostProcessPrepareOptions = {}): HostProcessSnapshot {
    const record: HostProcessRecord = {
      pid: this.nextPid++,
      generation: this.nextGeneration++,
      parent: options.parent || null,
      cwd: options.cwd || "/workspace",
      env: { ...(options.env || {}) },
      url: options.url,
      status: "prepared",
      exitCode: null,
      waiters: [],
      resourcesReleased: false
    };
    this.records.set(record.pid, record);
    return snapshot(record);
  }

  async start(pid: number): Promise<HostProcessSnapshot> {
    const record = this.#record(pid);
    if (record.status !== "prepared") throw new HostProcessError(`cannot start process in ${record.status}`);
    if (!record.url) return this.#finish(record, "failed", 1, "missing worker url");

    record.status = "starting";
    const worker = this.workerFactory(record);
    this.registry.register(record.pid, record.generation, worker);

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        if (isTerminal(record.status)) {
          resolve(snapshot(record));
          return;
        }
        resolve(this.#finish(record, "failed", 1, "startup timeout"));
      }, 1000);
      const onMessage = (event: Event) => {
        const data = "data" in event ? event.data as { type?: string; error?: string; code?: number } : {};
        if (data?.type === "ready") {
          cleanup();
          record.status = "ready";
          resolve(snapshot(record));
        } else if (data?.type === "failed") {
          cleanup();
          resolve(this.#finish(record, "failed", 1, data.error || "startup failed"));
        } else if (data?.type === "exit") {
          cleanup();
          resolve(this.#finish(record, "exited", data.code ?? 0));
        }
      };
      const onError = (event: Event) => {
        const errorEvent = event as ErrorEvent;
        cleanup();
        resolve(this.#finish(record, "failed", 1, errorEvent.message || "worker error"));
      };
      const cleanup = () => {
        clearTimeout(timeout);
        worker.removeEventListener?.("message", onMessage);
        worker.removeEventListener?.("error", onError);
      };
      worker.addEventListener?.("message", onMessage);
      worker.addEventListener?.("error", onError);
      worker.postMessage?.({
        type: "start",
        pid: record.pid,
        generation: record.generation,
        cwd: record.cwd,
        env: record.env
      });
    });
  }

  wait(pid: number): Promise<HostProcessSnapshot> {
    const record = this.#record(pid);
    if (isTerminal(record.status)) return Promise.resolve(snapshot(record));
    return new Promise((resolve) => record.waiters.push(resolve));
  }

  stop(pid: number, code = 0): HostProcessSnapshot {
    const record = this.#record(pid);
    if (isTerminal(record.status)) return snapshot(record);
    return this.#finish(record, "exited", code);
  }

  kill(pid: number): HostProcessSnapshot {
    const record = this.#record(pid);
    if (isTerminal(record.status)) return snapshot(record);
    return this.#finish(record, "killed", 137);
  }

  teardown(): void {
    for (const record of this.records.values()) {
      if (!isTerminal(record.status)) {
        this.#finish(record, "killed", 137);
      }
    }
    this.registry.terminateAll();
  }

  #finish(record: HostProcessRecord, status: HostProcessStatus, exitCode: number, error: string | null = null): HostProcessSnapshot {
    record.status = status;
    record.exitCode = exitCode;
    record.error = error;
    record.resourcesReleased = true;
    this.registry.terminate(record.pid, record.generation);
    const current = snapshot(record);
    for (const waiter of record.waiters.splice(0)) waiter(current);
    return current;
  }

  #record(pid: number): HostProcessRecord {
    const record = this.records.get(pid);
    if (!record) throw new HostProcessError(`unknown pid ${pid}`);
    return record;
  }
}

function isTerminal(status: HostProcessStatus): boolean {
  return status === "failed" || status === "exited" || status === "killed";
}

function snapshot(record: HostProcessRecord): HostProcessSnapshot {
  return {
    pid: record.pid,
    generation: record.generation,
    parent: record.parent,
    cwd: record.cwd,
    env: { ...record.env },
    status: record.status,
    exitCode: record.exitCode,
    error: record.error || null,
    resourcesReleased: Boolean(record.resourcesReleased)
  };
}
