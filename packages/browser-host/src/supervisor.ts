export class RuntimeBootError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = "RuntimeBootError";
    this.cause = cause;
  }
}

const defaultSyncChannelBytes = 1024 * 1024 + 4096;

export class BrowserRuntimeSupervisor {
  #options;
  #systemWorker = null;
  #processWorker = null;
  #status = "idle";
  #metrics = {
    bootCount: 0,
    teardownCount: 0,
    activeWorkers: 0,
    pendingRequests: 0
  };

  constructor(options = {}) {
    this.#options = {
      timeoutMs: 2000,
      ...options
    };
  }

  get status() {
    return this.#status;
  }

  get metrics() {
    return { ...this.#metrics };
  }

  async boot(bootOptions = {}) {
    if (this.#status !== "idle" && this.#status !== "stopped") {
      throw new RuntimeBootError(`Cannot boot runtime while status is ${this.#status}`);
    }

    this.#status = "booting";
    const systemWorker = this.#createWorker(this.#options.systemWorkerUrl, "cargo-container-system");
    const processWorker = this.#createWorker(this.#options.processWorkerUrl, "cargo-container-process-0");
    const channel = new MessageChannel();
    const syncChannel = this.#createSyncChannel(bootOptions);

    this.#systemWorker = systemWorker;
    this.#processWorker = processWorker;
    this.#metrics.activeWorkers = 2;

    try {
      const processReady = this.#waitForWorker(processWorker, "process", bootOptions);
      processWorker.postMessage({
        type: "boot",
        fail: Boolean(bootOptions.forceProcessFailure),
        port: channel.port2,
        syncChannel
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
      this.#status = "failed";
      await this.teardown();
      throw error instanceof RuntimeBootError
        ? error
        : new RuntimeBootError("Runtime boot failed", error);
    }
  }

  async teardown() {
    const workers = [this.#systemWorker, this.#processWorker].filter(Boolean);
    this.#systemWorker = null;
    this.#processWorker = null;
    for (const worker of workers) worker.terminate();
    this.#metrics.activeWorkers = 0;
    this.#metrics.pendingRequests = 0;
    this.#metrics.teardownCount += 1;
    this.#status = "stopped";
  }

  run(source, options = {}) {
    if (this.#status !== "ready") {
      throw new RuntimeBootError(`Cannot run program while status is ${this.#status}`);
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

  systemMetrics(options = {}) {
    if (this.#status !== "ready") {
      throw new RuntimeBootError(`Cannot read system metrics while status is ${this.#status}`);
    }
    return this.#sendSystemRequest({
      type: "get-metrics",
      requestId: options.requestId || Date.now()
    }, options.timeoutMs || this.#options.timeoutMs);
  }

  #createWorker(url, name) {
    if (!url) throw new RuntimeBootError("Missing Worker URL");
    return new Worker(url, {
      type: "module",
      name
    });
  }

  #createSyncChannel(bootOptions) {
    if (bootOptions.disableSyncChannel) return null;
    if (typeof SharedArrayBuffer !== "function") {
      throw new RuntimeBootError("SharedArrayBuffer is unavailable; check cross-origin isolation");
    }
    return new SharedArrayBuffer(bootOptions.syncChannelBytes || defaultSyncChannelBytes);
  }

  #waitForWorker(worker, role, bootOptions) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        fail(new RuntimeBootError(`${role} worker readiness timeout`));
      }, bootOptions.timeoutMs || this.#options.timeoutMs);

      const cleanup = () => {
        clearTimeout(timeout);
        worker.removeEventListener("message", onMessage);
        worker.removeEventListener("error", onError);
      };

      const fail = (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };

      const onMessage = (event) => {
        if (event.data?.type === "ready") {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(event.data);
        } else if (event.data?.type === "failed") {
          fail(new RuntimeBootError(`${role[0].toUpperCase()}${role.slice(1)} worker failed: ${event.data.error}`));
        }
      };

      const onError = (event) => fail(new RuntimeBootError(event.message || `${role} worker error`));

      worker.addEventListener("message", onMessage);
      worker.addEventListener("error", onError);
    });
  }

  #sendProcessRequest(message, timeoutMs) {
    return new Promise((resolve, reject) => {
      const worker = this.#processWorker;
      if (!worker) {
        reject(new RuntimeBootError("Process worker is not running"));
        return;
      }

      let settled = false;
      this.#metrics.pendingRequests += 1;
      const timeout = setTimeout(() => fail(new RuntimeBootError("process worker request timeout")), timeoutMs);
      const cleanup = () => {
        clearTimeout(timeout);
        this.#metrics.pendingRequests = Math.max(0, this.#metrics.pendingRequests - 1);
        worker.removeEventListener("message", onMessage);
        worker.removeEventListener("error", onError);
      };
      const fail = (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const onMessage = (event) => {
        if (event.data?.type !== "run-result") return;
        if (settled) return;
        settled = true;
        cleanup();
        if (event.data.ok) resolve(event.data);
        else reject(new RuntimeBootError(event.data.error || "process worker request failed"));
      };
      const onError = (event) => fail(new RuntimeBootError(event.message || "process worker error"));

      worker.addEventListener("message", onMessage);
      worker.addEventListener("error", onError);
      worker.postMessage(message);
    });
  }

  #sendSystemRequest(message, timeoutMs) {
    return new Promise((resolve, reject) => {
      const worker = this.#systemWorker;
      if (!worker) {
        reject(new RuntimeBootError("System worker is not running"));
        return;
      }

      let settled = false;
      this.#metrics.pendingRequests += 1;
      const timeout = setTimeout(() => fail(new RuntimeBootError("system worker request timeout")), timeoutMs);
      const cleanup = () => {
        clearTimeout(timeout);
        this.#metrics.pendingRequests = Math.max(0, this.#metrics.pendingRequests - 1);
        worker.removeEventListener("message", onMessage);
        worker.removeEventListener("error", onError);
      };
      const fail = (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const onMessage = (event) => {
        if (event.data?.type !== "metrics-result" || event.data.requestId !== message.requestId) return;
        if (settled) return;
        settled = true;
        cleanup();
        resolve(event.data.metrics);
      };
      const onError = (event) => fail(new RuntimeBootError(event.message || "system worker error"));

      worker.addEventListener("message", onMessage);
      worker.addEventListener("error", onError);
      worker.postMessage(message);
    });
  }
}
