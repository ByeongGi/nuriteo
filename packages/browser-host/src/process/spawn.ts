import { WorkerRegistry } from "./worker-registry.ts";
import type { HostProcessOutputChunk, HostProcessPrepareOptions, HostProcessRecord, HostProcessResize, HostProcessSignal, HostProcessSnapshot, HostProcessStatus, HostProcessTableOptions, HostWorkerLike } from "./types.ts";
import type { RuntimeTraceSink } from "../observability/index.ts";
import {
  assertAbuseAllowed,
  createAbuseLimitPolicy,
  type AbuseLimitPolicy,
  type PermissionManager
} from "../security/index.ts";

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
  permissions: PermissionManager | null;
  abusePolicy: AbuseLimitPolicy;
  trace: RuntimeTraceSink | null;
  workerFactory: (record: HostProcessRecord) => HostWorkerLike;
  now: () => number;
  onOutput: ((chunk: HostProcessOutputChunk) => void) | null;
  outputListeners: Set<(chunk: HostProcessOutputChunk) => void>;

  constructor(options: HostProcessTableOptions = {}) {
    this.nextPid = 1;
    this.nextGeneration = 1;
    this.records = new Map();
    this.registry = options.registry || new WorkerRegistry();
    this.permissions = options.permissions || null;
    this.abusePolicy = options.abusePolicy || createAbuseLimitPolicy();
    this.trace = options.trace || null;
    this.workerFactory = options.workerFactory || ((record) => new Worker(record.url as string | URL, { type: "module", name: `process-${record.pid}` }));
    this.now = options.now || Date.now;
    this.onOutput = options.onOutput || null;
    this.outputListeners = new Set();
  }

  prepare(options: HostProcessPrepareOptions = {}): HostProcessSnapshot {
    const span = this.trace?.startSpan({
      category: "process",
      name: "host-process.prepare",
      ...(options.projectId ? { requestId: options.projectId } : {}),
      attributes: { resource: String(options.url || "<inline>") }
    });
    try {
      this.permissions?.assertAllowed({
        scope: "process",
        action: "prepare",
        resource: String(options.url || "<inline>"),
        ...(options.projectId ? { projectId: options.projectId } : {})
      });
      assertAbuseAllowed({
        kind: "worker-spawn",
        // Count reserved/active process slots, not only started workers.
        // Workers register in start(); prepare() must still enforce the spawn ceiling.
        workerSpawnCount: this.#activeProcessCount() + 1,
        ...(options.projectId ? { projectId: options.projectId } : {})
      }, this.abusePolicy);
    } catch (error) {
      span?.end({ status: "error", errorCode: error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : "EUNKNOWN" });
      throw error;
    }
    const record: HostProcessRecord = {
      pid: this.nextPid++,
      generation: this.nextGeneration++,
      parent: options.parent || null,
      cwd: options.cwd || "/workspace",
      env: { ...(options.env || {}) },
      ...(options.projectId ? { projectId: options.projectId } : {}),
      url: options.url,
      status: "prepared",
      exitCode: null,
      output: [],
      stdout: "",
      stderr: "",
      waiters: [],
      resourcesReleased: false
    };
    this.records.set(record.pid, record);
    const current = snapshot(record);
    span?.end({ attributes: { pid: current.pid, generation: current.generation } });
    return current;
  }

  async start(pid: number): Promise<HostProcessSnapshot> {
    const record = this.#record(pid);
    if (record.status !== "prepared") throw new HostProcessError(`cannot start process in ${record.status}`);
    if (!record.url) return this.#finish(record, "failed", 1, "missing worker url");

    assertAbuseAllowed({
      kind: "worker-spawn",
      workerSpawnCount: this.registry.size() + 1,
      ...(record.projectId ? { projectId: record.projectId } : {})
    }, this.abusePolicy);

    record.status = "starting";
    const worker = this.workerFactory(record);
    this.registry.register(record.pid, record.generation, worker);

    return new Promise((resolve) => {
      let resolved = false;
      const timeout = setTimeout(() => {
        if (isTerminal(record.status)) {
          resolveOnce(snapshot(record));
          return;
        }
        resolveOnce(this.#finish(record, "failed", 1, "startup timeout"));
      }, 1000);
      const onMessage = (event: Event) => {
        const data = "data" in event ? event.data as { type?: string; error?: string; code?: number; data?: string } : {};
        if (data?.type === "ready") {
          record.status = "ready";
          clearTimeout(timeout);
          resolveOnce(snapshot(record));
        } else if (data?.type === "stdout" || data?.type === "stderr") {
          this.#appendOutput(record, data.type, data.data || "");
        } else if (data?.type === "failed") {
          resolveOnce(this.#finish(record, "failed", 1, data.error || "startup failed"));
        } else if (data?.type === "exit") {
          resolveOnce(this.#finish(record, "exited", data.code ?? 0));
        }
      };
      const onError = (event: Event) => {
        const errorEvent = event as ErrorEvent;
        resolveOnce(this.#finish(record, "failed", 1, errorEvent.message || "worker error"));
      };
      const cleanup = () => {
        clearTimeout(timeout);
        worker.removeEventListener?.("message", onMessage);
        worker.removeEventListener?.("error", onError);
      };
      const resolveOnce = (current: HostProcessSnapshot) => {
        if (resolved) return;
        resolved = true;
        resolve(current);
      };
      record.waiters.push(resolveOnce);
      record.cleanup = cleanup;
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

  output(pid: number): HostProcessOutputChunk[] {
    const record = this.#record(pid);
    return record.output.map((chunk) => ({ ...chunk }));
  }

  list(options: { activeOnly?: boolean; projectId?: string } = {}): HostProcessSnapshot[] {
    return [...this.records.values()]
      .filter((record) => !options.activeOnly || !isTerminal(record.status))
      .filter((record) => !options.projectId || record.projectId === options.projectId)
      .map(snapshot);
  }

  subscribeOutput(listener: (chunk: HostProcessOutputChunk) => void): () => void {
    this.outputListeners.add(listener);
    return () => {
      this.outputListeners.delete(listener);
    };
  }

  writeStdin(pid: number, data: string): boolean {
    const record = this.#record(pid);
    if (isTerminal(record.status)) return false;
    const worker = this.registry.get(record.pid, record.generation);
    if (!worker?.postMessage) return false;
    worker.postMessage({ type: "stdin", pid: record.pid, generation: record.generation, data });
    return true;
  }

  resize(pid: number, size: HostProcessResize): boolean {
    if (!Number.isInteger(size.cols) || !Number.isInteger(size.rows) || size.cols < 1 || size.rows < 1) {
      throw new RangeError("process terminal size must use positive integer columns and rows");
    }
    const record = this.#record(pid);
    if (isTerminal(record.status)) return false;
    const worker = this.registry.get(record.pid, record.generation);
    if (!worker?.postMessage) return false;
    worker.postMessage({ type: "resize", pid: record.pid, generation: record.generation, ...size });
    return true;
  }

  signal(pid: number, signal: HostProcessSignal): HostProcessSnapshot {
    const record = this.#record(pid);
    if (isTerminal(record.status)) return snapshot(record);
    const worker = this.registry.get(record.pid, record.generation);
    worker?.postMessage?.({ type: "signal", pid: record.pid, generation: record.generation, signal });
    if (signal === "SIGINT") return this.#finish(record, "exited", 130);
    if (signal === "SIGTERM") return this.#finish(record, "exited", 143);
    return this.#finish(record, "killed", 137);
  }

  stop(pid: number, code = 0): HostProcessSnapshot {
    const record = this.#record(pid);
    if (isTerminal(record.status)) return snapshot(record);
    return this.#finish(record, "exited", code);
  }

  kill(pid: number): HostProcessSnapshot {
    const record = this.#record(pid);
    if (isTerminal(record.status)) return snapshot(record);
    return this.signal(pid, "SIGKILL");
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
    record.cleanup?.();
    delete record.cleanup;
    record.status = status;
    record.exitCode = exitCode;
    record.error = error;
    record.resourcesReleased = true;
    this.registry.terminate(record.pid, record.generation);
    const current = snapshot(record);
    for (const waiter of record.waiters.splice(0)) waiter(current);
    return current;
  }

  #appendOutput(record: HostProcessRecord, stream: "stdout" | "stderr", data: string): void {
    if (!data) return;
    const chunk = {
      pid: record.pid,
      generation: record.generation,
      stream,
      data,
      at: this.now()
    };
    record.output.push(chunk);
    if (stream === "stdout") record.stdout += data;
    else record.stderr += data;
    this.onOutput?.({ ...chunk });
    for (const listener of this.outputListeners) listener({ ...chunk });
  }

  #record(pid: number): HostProcessRecord {
    const record = this.records.get(pid);
    if (!record) throw new HostProcessError(`unknown pid ${pid}`);
    return record;
  }

  #activeProcessCount(): number {
    let count = 0;
    for (const record of this.records.values()) {
      if (!isTerminal(record.status)) count += 1;
    }
    return count;
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
    ...(record.projectId ? { projectId: record.projectId } : {}),
    status: record.status,
    exitCode: record.exitCode,
    error: record.error || null,
    stdout: record.stdout,
    stderr: record.stderr,
    resourcesReleased: Boolean(record.resourcesReleased)
  };
}
