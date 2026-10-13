import { WorkerRegistry } from "./worker-registry.ts";
import type { HostProcessOutputChunk, HostProcessPrepareOptions, HostProcessRecord, HostProcessResize, HostProcessSignal, HostProcessSnapshot, HostProcessStatus, HostProcessTableOptions, HostProcessTerminalMode, HostWorkerLike } from "./types.ts";
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
  maxOutputBytes: number;
  maxOutputChunks: number;
  stdinWindowBytes: number;
  startupTimeoutMs: number;
  signalGraceMs: number;
  workerInitialization: HostProcessTableOptions["workerInitialization"];

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
    this.maxOutputBytes = positiveLimit(options.maxOutputBytes, 1024 * 1024, "maxOutputBytes");
    this.maxOutputChunks = positiveLimit(options.maxOutputChunks, 1024, "maxOutputChunks");
    this.stdinWindowBytes = positiveLimit(options.stdinWindowBytes, 64 * 1024, "stdinWindowBytes");
    this.startupTimeoutMs = nonNegativeLimit(options.startupTimeoutMs, 5000, "startupTimeoutMs");
    this.signalGraceMs = nonNegativeLimit(options.signalGraceMs, 500, "signalGraceMs");
    this.workerInitialization = options.workerInitialization;
  }

  prepare(options: HostProcessPrepareOptions = {}): HostProcessSnapshot {
    const cwd = validateCwd(options.cwd || "/workspace");
    const argv = validateArgv(options.argv || []);
    const env = validateEnv(options.env || {});
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
      cwd,
      env,
      argv,
      ...(options.projectId ? { projectId: options.projectId } : {}),
      url: options.url,
      status: "prepared",
      exitCode: null,
      output: [],
      stdout: "",
      stderr: "",
      outputBytes: 0,
      outputDroppedBytes: 0,
      stdinPendingBytes: 0,
      signal: null,
      terminalMode: normalizeTerminalMode(options.terminalMode),
      terminalSize: { cols: 80, rows: 24 },
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
    let worker: HostWorkerLike;
    try {
      worker = this.workerFactory(record);
      this.registry.register(record.pid, record.generation, worker);
    } catch (error) {
      return this.#finish(record, "failed", 1, error instanceof Error ? error.message : String(error));
    }

    return new Promise((resolve) => {
      let resolved = false;
      const timeout = setTimeout(() => {
        if (isTerminal(record.status)) {
          resolveOnce(snapshot(record));
          return;
        }
        resolveOnce(this.#finish(record, "failed", 1, "startup timeout"));
      }, this.startupTimeoutMs);
      const onMessage = (event: Event) => {
        const data = "data" in event ? event.data as { type?: string; error?: string; code?: number; data?: string; bytes?: number; pid?: number; generation?: number } : {};
        if ((data.pid !== undefined && data.pid !== record.pid) ||
            (data.generation !== undefined && data.generation !== record.generation)) return;
        if (data?.type === "runtime-initialized") {
          postStart();
        } else if (data?.type === "ready") {
          if (!record.signal) record.status = "ready";
          clearTimeout(timeout);
          resolveOnce(snapshot(record));
        } else if (data?.type === "stdout" || data?.type === "stderr") {
          this.#appendOutput(record, data.type, data.data || "");
          worker.postMessage?.({
            type: "output-ack",
            pid: record.pid,
            generation: record.generation,
            bytes: byteLength(data.data || "")
          });
        } else if (data?.type === "stdin-ack") {
          record.stdinPendingBytes = Math.max(0, record.stdinPendingBytes - Math.max(0, data.bytes || 0));
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
      const postStart = () => {
        try {
          worker.postMessage?.({
            type: "start",
            pid: record.pid,
            generation: record.generation,
            cwd: record.cwd,
            env: record.env,
            argv: [...record.argv],
            terminalMode: { ...record.terminalMode },
            terminal: { ...record.terminalSize },
            outputWindowBytes: this.maxOutputBytes,
            stdinWindowBytes: this.stdinWindowBytes
          });
        } catch (error) {
          resolveOnce(this.#finish(record, "failed", 1, error instanceof Error ? error.message : String(error)));
        }
      };
      try {
        if (this.workerInitialization) {
          worker.postMessage?.({
            type: "initialize-runtime",
            systemWasmUrl: String(this.workerInitialization.systemWasmUrl)
          });
        } else postStart();
      } catch (error) {
        resolveOnce(this.#finish(record, "failed", 1, error instanceof Error ? error.message : String(error)));
      }
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

  release(pid: number): boolean {
    const record = this.#record(pid);
    if (!isTerminal(record.status)) return false;
    return this.records.delete(pid);
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
    const bytes = byteLength(data);
    if (bytes === 0) return true;
    if (bytes > this.stdinWindowBytes || record.stdinPendingBytes + bytes > this.stdinWindowBytes) return false;
    record.stdinPendingBytes += bytes;
    try {
      worker.postMessage({ type: "stdin", pid: record.pid, generation: record.generation, data, bytes });
    } catch (error) {
      record.stdinPendingBytes -= bytes;
      throw error;
    }
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
    record.terminalSize = { ...size };
    worker.postMessage({ type: "resize", pid: record.pid, generation: record.generation, ...size });
    return true;
  }

  signal(pid: number, signal: HostProcessSignal): HostProcessSnapshot {
    const record = this.#record(pid);
    if (isTerminal(record.status)) return snapshot(record);
    const worker = this.registry.get(record.pid, record.generation);
    if (record.signalTimer) clearTimeout(record.signalTimer);
    delete record.signalTimer;
    record.signal = signal;
    worker?.postMessage?.({ type: "signal", pid: record.pid, generation: record.generation, signal });
    if (signal === "SIGKILL") return this.#finish(record, "killed", 137);
    record.status = "stopping";
    const exitCode = signal === "SIGINT" ? 130 : 143;
    record.signalTimer = setTimeout(() => {
      if (!isTerminal(record.status)) this.#finish(record, "exited", exitCode);
    }, this.signalGraceMs);
    return snapshot(record);
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
    if (record.signalTimer) clearTimeout(record.signalTimer);
    delete record.signalTimer;
    record.cleanup?.();
    delete record.cleanup;
    record.status = status;
    record.exitCode = exitCode;
    record.error = error;
    record.resourcesReleased = true;
    record.stdinPendingBytes = 0;
    try {
      this.registry.terminate(record.pid, record.generation);
    } catch (error) {
      record.error ||= error instanceof Error ? error.message : String(error);
    }
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
    record.outputBytes += byteLength(data);
    while (record.output.length > this.maxOutputChunks || record.outputBytes > this.maxOutputBytes) {
      const first = record.output[0];
      if (!first) break;
      const overflow = Math.max(0, record.outputBytes - this.maxOutputBytes);
      const firstBytes = byteLength(first.data);
      if (record.output.length <= this.maxOutputChunks && overflow > 0 && overflow < firstBytes) {
        const retained = utf8Tail(first.data, firstBytes - overflow);
        record.outputDroppedBytes += firstBytes - byteLength(retained);
        record.outputBytes -= firstBytes - byteLength(retained);
        first.data = retained;
        break;
      }
      record.output.shift();
      record.outputBytes -= firstBytes;
      record.outputDroppedBytes += firstBytes;
    }
    record.stdout = record.output.filter((item) => item.stream === "stdout").map((item) => item.data).join("");
    record.stderr = record.output.filter((item) => item.stream === "stderr").map((item) => item.data).join("");
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
    env: redactEnv(record.env),
    argv: [...record.argv],
    ...(record.projectId ? { projectId: record.projectId } : {}),
    status: record.status,
    exitCode: record.exitCode,
    error: record.error || null,
    stdout: record.stdout,
    stderr: record.stderr,
    outputBytes: record.outputBytes,
    outputDroppedBytes: record.outputDroppedBytes,
    stdinPendingBytes: record.stdinPendingBytes,
    signal: record.signal,
    terminalMode: { ...record.terminalMode },
    terminalSize: { ...record.terminalSize },
    resourcesReleased: Boolean(record.resourcesReleased)
  };
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function utf8Tail(value: string, maxBytes: number): string {
  const bytes = new TextEncoder().encode(value);
  return new TextDecoder().decode(bytes.slice(Math.max(0, bytes.byteLength - maxBytes)));
}

function positiveLimit(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1) throw new RangeError(`${name} must be a positive safe integer`);
  return resolved;
}

function nonNegativeLimit(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 0) throw new RangeError(`${name} must be a non-negative safe integer`);
  return resolved;
}

function normalizeTerminalMode(mode: Partial<HostProcessTerminalMode> | undefined): HostProcessTerminalMode {
  return {
    canonical: mode?.canonical ?? false,
    echo: mode?.echo ?? false,
    signals: mode?.signals ?? true
  };
}

function validateCwd(cwd: string): string {
  const segments = cwd.split("/");
  if (!cwd.startsWith("/") || cwd.includes("\0") || segments.includes("..") || segments.includes(".")) {
    throw new HostProcessError("process cwd must be an absolute normalized path");
  }
  return cwd.replace(/\/{2,}/g, "/").replace(/\/$/, "") || "/";
}

function validateArgv(argv: string[]): string[] {
  if (!Array.isArray(argv) || argv.length > 256) throw new HostProcessError("process argv exceeds 256 entries");
  let bytes = 0;
  const clone = argv.map((value) => {
    if (typeof value !== "string" || value.includes("\0")) throw new HostProcessError("process argv must contain NUL-free strings");
    bytes += byteLength(value);
    return value;
  });
  if (bytes > 64 * 1024) throw new HostProcessError("process argv exceeds 65536 bytes");
  return clone;
}

function validateEnv(env: Record<string, string>): Record<string, string> {
  const clone: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || typeof value !== "string" || value.includes("\0")) {
      throw new HostProcessError(`invalid process environment entry: ${name}`);
    }
    clone[name] = value;
  }
  return clone;
}

function redactEnv(env: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(env).map(([name, value]) => [
    name,
    /(SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|AUTH|COOKIE)/i.test(name) ? "[REDACTED]" : value
  ]));
}
