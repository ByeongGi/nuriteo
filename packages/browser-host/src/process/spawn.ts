import { WorkerRegistry } from "./worker-registry.ts";

export class HostProcessError extends Error {
  constructor(message) {
    super(message);
    this.name = "HostProcessError";
  }
}

export class HostProcessTable {
  constructor(options = {}) {
    this.nextPid = 1;
    this.nextGeneration = 1;
    this.records = new Map();
    this.registry = options.registry || new WorkerRegistry();
    this.workerFactory = options.workerFactory || ((record) => new Worker(record.url, { type: "module", name: `process-${record.pid}` }));
  }

  prepare(options = {}) {
    const record = {
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

  async start(pid) {
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
      const onMessage = (event) => {
        const data = event.data || event;
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
      const onError = (event) => {
        cleanup();
        resolve(this.#finish(record, "failed", 1, event.message || "worker error"));
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

  wait(pid) {
    const record = this.#record(pid);
    if (isTerminal(record.status)) return Promise.resolve(snapshot(record));
    return new Promise((resolve) => record.waiters.push(resolve));
  }

  stop(pid, code = 0) {
    const record = this.#record(pid);
    if (isTerminal(record.status)) return snapshot(record);
    return this.#finish(record, "exited", code);
  }

  kill(pid) {
    const record = this.#record(pid);
    if (isTerminal(record.status)) return snapshot(record);
    return this.#finish(record, "killed", 137);
  }

  teardown() {
    for (const record of this.records.values()) {
      if (!isTerminal(record.status)) {
        this.#finish(record, "killed", 137);
      }
    }
    this.registry.terminateAll();
  }

  #finish(record, status, exitCode, error = null) {
    record.status = status;
    record.exitCode = exitCode;
    record.error = error;
    record.resourcesReleased = true;
    this.registry.terminate(record.pid, record.generation);
    const current = snapshot(record);
    for (const waiter of record.waiters.splice(0)) waiter(current);
    return current;
  }

  #record(pid) {
    const record = this.records.get(pid);
    if (!record) throw new HostProcessError(`unknown pid ${pid}`);
    return record;
  }
}

function isTerminal(status) {
  return status === "failed" || status === "exited" || status === "killed";
}

function snapshot(record) {
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
