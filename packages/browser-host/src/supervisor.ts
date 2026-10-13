import type { MessageDetails, ReadyMessage } from "../../protocol/src/index.ts";
import {
  assertBrowserRuntimeResourceAdmission,
  BrowserRuntimeResourceError,
  DEFAULT_BROWSER_RUNTIME_MEMORY_LIMIT_BYTES,
  type BrowserRuntimeResourceEstimate
} from "./resources/index.ts";

export type RuntimeStatus = "idle" | "booting" | "ready" | "failed" | "stopped";

export interface RuntimeMetrics {
  bootCount: number;
  teardownCount: number;
  activeWorkers: number;
  admissionRejections: number;
  lastAdmissionBytes: number;
  pendingRequests: number;
  watchdogTerminations: number;
}

export interface BrowserRuntimeSupervisorOptions {
  systemWorkerUrl?: string | URL | undefined;
  processWorkerUrl?: string | URL | undefined;
  systemWasmUrl?: string | URL | undefined;
  memoryLimitBytes?: number;
  timeoutMs?: number;
}

export interface RuntimeBootOptions {
  timeoutMs?: number;
  disableSyncChannel?: boolean;
  syncChannelBytes?: number;
  forceProcessFailure?: boolean;
  forceSystemFailure?: boolean;
}

export interface RuntimeRunOptions {
  entrypoint?: string;
  generation?: number;
  pid?: number;
  timeoutMs?: number;
  syscallTimeoutMs?: number;
  resourceEstimate?: Omit<BrowserRuntimeResourceEstimate, "sourceBytes">;
}

export interface RuntimeSystemMetricsOptions {
  requestId?: number;
  timeoutMs?: number;
}

export interface RuntimeRunRequest {
  type: "run";
  source: string;
  entrypoint?: string | undefined;
  generation: number;
  pid: number;
  timeoutMs: number;
}

export interface RuntimeRunResult {
  type: "run-result";
  ok: boolean;
  error?: string;
  [key: string]: unknown;
}

export interface RuntimeSystemMetricsRequest {
  type: "get-metrics";
  requestId: number;
}

type RuntimeMessageData = {
  type?: string;
  protocolVersion?: number;
  role?: string;
  error?: string;
  ok?: boolean;
  requestId?: number;
  metrics?: MessageDetails;
  details?: MessageDetails;
};

type ResolvedBrowserRuntimeSupervisorOptions = BrowserRuntimeSupervisorOptions & {
  memoryLimitBytes: number;
  timeoutMs: number;
};

function isReadyMessage(data: RuntimeMessageData): data is ReadyMessage {
  return data.type === "ready" && typeof data.protocolVersion === "number" && typeof data.role === "string" && typeof data.details === "object" && data.details !== null;
}

function isRunResult(data: RuntimeMessageData): data is RuntimeRunResult {
  return data.type === "run-result" && typeof data.ok === "boolean";
}

export class RuntimeBootError extends Error {
  cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "RuntimeBootError";
    this.cause = cause;
  }
}

const defaultSyncChannelBytes = 1024 * 1024 + 4096;

export class BrowserRuntimeSupervisor {
  #options: ResolvedBrowserRuntimeSupervisorOptions;
  #systemWorker: Worker | null = null;
  #processWorker: Worker | null = null;
  #status: RuntimeStatus = "idle";
  #pendingCancellations = new Set<() => void>();
  #metrics: RuntimeMetrics = {
    bootCount: 0,
    teardownCount: 0,
    activeWorkers: 0,
    admissionRejections: 0,
    lastAdmissionBytes: 0,
    pendingRequests: 0,
    watchdogTerminations: 0
  };

  constructor(options: BrowserRuntimeSupervisorOptions = {}) {
    this.#options = {
      systemWorkerUrl: options.systemWorkerUrl,
      processWorkerUrl: options.processWorkerUrl,
      ...options,
      memoryLimitBytes: options.memoryLimitBytes ?? DEFAULT_BROWSER_RUNTIME_MEMORY_LIMIT_BYTES,
      timeoutMs: options.timeoutMs ?? 2000
    };
  }

  get status(): RuntimeStatus {
    return this.#status;
  }

  get metrics(): RuntimeMetrics {
    return { ...this.#metrics };
  }

  async boot(bootOptions: RuntimeBootOptions = {}): Promise<ReadyMessage> {
    if (this.#status !== "idle" && this.#status !== "stopped") {
      throw new RuntimeBootError(`Cannot boot runtime while status is ${this.#status}`);
    }

    this.#status = "booting";
    let channel: MessageChannel | null = null;

    try {
      // Validate cross-origin isolation before acquiring any Worker. Each later
      // resource is recorded on the instance immediately so teardown owns
      // partial construction failures as well as a completed boot.
      const syncChannel = this.#createSyncChannel(bootOptions);
      const systemWorker = this.#createWorker(this.#options.systemWorkerUrl, "nuriteo-system");
      this.#systemWorker = systemWorker;
      this.#metrics.activeWorkers = 1;
      const processWorker = this.#createWorker(this.#options.processWorkerUrl, "nuriteo-process-0");
      this.#processWorker = processWorker;
      this.#metrics.activeWorkers = 2;
      channel = new MessageChannel();

      const processReady = this.#waitForWorker(processWorker, "process", bootOptions);
      processWorker.postMessage({
        type: "boot",
        fail: Boolean(bootOptions.forceProcessFailure),
        port: channel.port2,
        syncChannel,
        systemWasmUrl: this.#options.systemWasmUrl ? String(this.#options.systemWasmUrl) : undefined
      }, [channel.port2]);
      const processResult = await processReady;

      const systemReady = this.#waitForWorker(systemWorker, "system", bootOptions);
      systemWorker.postMessage({
        type: "boot",
        fail: Boolean(bootOptions.forceSystemFailure),
        port: channel.port1,
        syncChannel
      }, [channel.port1]);
      const result = await systemReady;
      result.details.processReady = processResult.details;
      this.#status = "ready";
      this.#metrics.bootCount += 1;
      return result;
    } catch (error) {
      closeMessageChannel(channel);
      this.#status = "failed";
      await this.teardown();
      throw error instanceof RuntimeBootError
        ? error
        : new RuntimeBootError("Runtime boot failed", error);
    }
  }

  async teardown(): Promise<void> {
    this.#stopWorkers(false);
  }

  #stopWorkers(watchdog: boolean): void {
    const workers: Worker[] = [];
    if (this.#systemWorker) workers.push(this.#systemWorker);
    if (this.#processWorker) workers.push(this.#processWorker);
    const cancellations = [...this.#pendingCancellations];
    if (workers.length === 0 && cancellations.length === 0) {
      this.#status = "stopped";
      return;
    }
    this.#systemWorker = null;
    this.#processWorker = null;
    for (const cancel of cancellations) cancel();
    for (const worker of workers) worker.terminate();
    this.#metrics.activeWorkers = 0;
    this.#metrics.pendingRequests = 0;
    this.#metrics.teardownCount += 1;
    if (watchdog && workers.length > 0) this.#metrics.watchdogTerminations += 1;
    this.#status = "stopped";
  }

  run(source: string, options: RuntimeRunOptions = {}): Promise<RuntimeRunResult> {
    if (this.#status !== "ready") {
      throw new RuntimeBootError(`Cannot run program while status is ${this.#status}`);
    }
    try {
      const admission = assertBrowserRuntimeResourceAdmission({
        ...options.resourceEstimate,
        sourceBytes: new TextEncoder().encode(source).byteLength
      }, this.#options.memoryLimitBytes);
      this.#metrics.lastAdmissionBytes = admission.totalBytes;
    } catch (error) {
      if (error instanceof BrowserRuntimeResourceError) this.#metrics.admissionRejections += 1;
      throw error;
    }
    return this.#sendProcessRequest({
      type: "run",
      source,
      entrypoint: options.entrypoint,
      generation: options.generation || 2,
      pid: options.pid || 1,
      timeoutMs: options.syscallTimeoutMs || Math.max(1000, (options.timeoutMs || this.#options.timeoutMs) - 1000)
    }, options.timeoutMs || this.#options.timeoutMs);
  }

  systemMetrics(options: RuntimeSystemMetricsOptions = {}): Promise<MessageDetails> {
    if (this.#status !== "ready") {
      throw new RuntimeBootError(`Cannot read system metrics while status is ${this.#status}`);
    }
    return this.#sendSystemRequest({
      type: "get-metrics",
      requestId: options.requestId || Date.now()
    }, options.timeoutMs || this.#options.timeoutMs);
  }

  #createWorker(url: string | URL | undefined, name: string): Worker {
    if (!url) throw new RuntimeBootError("Missing Worker URL");
    return new Worker(url, {
      type: "module",
      name
    });
  }

  #createSyncChannel(bootOptions: RuntimeBootOptions): SharedArrayBuffer | null {
    if (bootOptions.disableSyncChannel) return null;
    if (typeof SharedArrayBuffer !== "function") {
      throw new RuntimeBootError("SharedArrayBuffer is unavailable; check cross-origin isolation");
    }
    return new SharedArrayBuffer(bootOptions.syncChannelBytes || defaultSyncChannelBytes);
  }

  #waitForWorker(worker: Worker, role: "system" | "process", bootOptions: RuntimeBootOptions): Promise<ReadyMessage> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        fail(new RuntimeBootError(`${role} worker readiness timeout`));
      }, bootOptions.timeoutMs || this.#options.timeoutMs);

      const cleanup = () => {
        clearTimeout(timeout);
        this.#pendingCancellations.delete(cancel);
        worker.removeEventListener("message", onMessage);
        worker.removeEventListener("error", onError);
      };

      const fail = (error: RuntimeBootError) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };

      const onMessage = (event: MessageEvent<RuntimeMessageData>) => {
        if (isReadyMessage(event.data)) {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(event.data);
        } else if (event.data?.type === "failed") {
          const label = role === "system" ? "System" : "Process";
          fail(new RuntimeBootError(`${label} worker failed: ${event.data.error}`));
        }
      };

      const onError = (event: ErrorEvent) => fail(new RuntimeBootError(event.message || `${role} worker error`));

      const cancel = () => fail(new RuntimeBootError(`${role} worker boot cancelled`));
      this.#pendingCancellations.add(cancel);
      worker.addEventListener("message", onMessage);
      worker.addEventListener("error", onError);
    });
  }

  #sendProcessRequest(message: RuntimeRunRequest, timeoutMs: number): Promise<RuntimeRunResult> {
    return new Promise((resolve, reject) => {
      const worker = this.#processWorker;
      if (!worker) {
        reject(new RuntimeBootError("Process worker is not running"));
        return;
      }

      let settled = false;
      this.#metrics.pendingRequests += 1;
      const timeout = setTimeout(() => fail(new RuntimeBootError("process worker request timeout"), true), timeoutMs);
      const cleanup = () => {
        clearTimeout(timeout);
        this.#pendingCancellations.delete(cancel);
        this.#metrics.pendingRequests = Math.max(0, this.#metrics.pendingRequests - 1);
        worker.removeEventListener("message", onMessage);
        worker.removeEventListener("error", onError);
      };
      const fail = (error: RuntimeBootError, watchdog = false) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (watchdog) this.#stopWorkers(true);
        reject(error);
      };
      const onMessage = (event: MessageEvent<RuntimeMessageData>) => {
        if (event.data?.type !== "run-result") return;
        if (settled) return;
        settled = true;
        cleanup();
        if (!isRunResult(event.data)) return;
        if (event.data.ok) resolve(event.data);
        else reject(new RuntimeBootError(event.data.error || "process worker request failed"));
      };
      const onError = (event: ErrorEvent) => fail(new RuntimeBootError(event.message || "process worker error"), true);

      const cancel = () => fail(new RuntimeBootError("process worker request cancelled"));
      this.#pendingCancellations.add(cancel);
      worker.addEventListener("message", onMessage);
      worker.addEventListener("error", onError);
      try {
        worker.postMessage(message);
      } catch (error) {
        fail(new RuntimeBootError("process worker request could not be posted", error), true);
      }
    });
  }

  #sendSystemRequest(message: RuntimeSystemMetricsRequest, timeoutMs: number): Promise<MessageDetails> {
    return new Promise((resolve, reject) => {
      const worker = this.#systemWorker;
      if (!worker) {
        reject(new RuntimeBootError("System worker is not running"));
        return;
      }

      let settled = false;
      this.#metrics.pendingRequests += 1;
      const timeout = setTimeout(() => fail(new RuntimeBootError("system worker request timeout"), true), timeoutMs);
      const cleanup = () => {
        clearTimeout(timeout);
        this.#pendingCancellations.delete(cancel);
        this.#metrics.pendingRequests = Math.max(0, this.#metrics.pendingRequests - 1);
        worker.removeEventListener("message", onMessage);
        worker.removeEventListener("error", onError);
      };
      const fail = (error: RuntimeBootError, watchdog = false) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (watchdog) this.#stopWorkers(true);
        reject(error);
      };
      const onMessage = (event: MessageEvent<RuntimeMessageData>) => {
        if (event.data?.type !== "metrics-result" || event.data.requestId !== message.requestId) return;
        if (settled) return;
        settled = true;
        cleanup();
        resolve(event.data.metrics || {});
      };
      const onError = (event: ErrorEvent) => fail(new RuntimeBootError(event.message || "system worker error"), true);

      const cancel = () => fail(new RuntimeBootError("system worker request cancelled"));
      this.#pendingCancellations.add(cancel);
      worker.addEventListener("message", onMessage);
      worker.addEventListener("error", onError);
      try {
        worker.postMessage(message);
      } catch (error) {
        fail(new RuntimeBootError("system worker request could not be posted", error), true);
      }
    });
  }
}

function closeMessageChannel(channel: MessageChannel | null): void {
  if (!channel) return;
  try { channel.port1.close(); } catch { /* a transferred port may already be detached */ }
  try { channel.port2.close(); } catch { /* a transferred port may already be detached */ }
}
