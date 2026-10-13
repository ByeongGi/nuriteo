import { LivenessTracker } from "./liveness.ts";
import { RuntimeProcess } from "./process.ts";
import type { LivenessHandle, RuntimeTaskCallback } from "./types.ts";

interface RuntimeSchedulerOptions {
  process?: RuntimeProcess;
  liveness?: LivenessTracker;
  maxCallbacksPerRun?: number;
  yieldEveryCallbacks?: number;
}

export class SchedulerLimitError extends Error {
  code = "ERR_NURITEO_SCHEDULER_LIMIT";

  constructor(limit: number) {
    super(`runtime scheduler exceeded ${limit} callbacks without becoming idle`);
    this.name = "SchedulerLimitError";
  }
}

interface ScheduledTimer {
  callback: RuntimeTaskCallback;
  due: number;
  sequence: number;
  handle: LivenessHandle;
}

interface ScheduledImmediate {
  callback: RuntimeTaskCallback;
  sequence: number;
  handle: LivenessHandle;
}

export class RuntimeScheduler {
  process: RuntimeProcess;
  liveness: LivenessTracker;
  nextTicks: RuntimeTaskCallback[];
  promiseJobs: RuntimeTaskCallback[];
  timers: ScheduledTimer[];
  immediates: ScheduledImmediate[];
  now: number;
  sequence: number;
  maxCallbacksPerRun: number;
  yieldEveryCallbacks: number;
  callbacksRun: number;

  constructor(options: RuntimeSchedulerOptions = {}) {
    this.process = options.process || new RuntimeProcess();
    this.liveness = options.liveness || new LivenessTracker();
    this.nextTicks = [];
    this.promiseJobs = [];
    this.timers = [];
    this.immediates = [];
    this.now = 0;
    this.sequence = 0;
    this.maxCallbacksPerRun = positiveInteger(options.maxCallbacksPerRun, 100_000, "maxCallbacksPerRun");
    this.yieldEveryCallbacks = positiveInteger(options.yieldEveryCallbacks, 1024, "yieldEveryCallbacks");
    this.callbacksRun = 0;
  }

  nextTick(callback: RuntimeTaskCallback): void {
    this.nextTicks.push(callback);
  }

  queuePromiseJob(callback: RuntimeTaskCallback): void {
    this.promiseJobs.push(callback);
  }

  setTimeout(callback: RuntimeTaskCallback, delay = 0): LivenessHandle {
    const handle = this.liveness.ref("timeout");
    this.timers.push({
      callback,
      due: this.now + Math.max(0, delay),
      sequence: this.sequence++,
      handle
    });
    return handle;
  }

  setImmediate(callback: RuntimeTaskCallback): LivenessHandle {
    const handle = this.liveness.ref("immediate");
    this.immediates.push({
      callback,
      sequence: this.sequence++,
      handle
    });
    return handle;
  }

  async runUntilIdle(): Promise<{ exitCode: number; exited: boolean; uncaughtException: unknown }> {
    this.callbacksRun = 0;
    while (!this.process.exited) {
      await this.drainMicrotasks();
      if (this.process.exited) break;

      const timer = this.takeDueTimer();
      if (timer) {
        await this.invoke(timer.callback);
        timer.handle.close();
        continue;
      }

      const immediate = this.immediates.shift();
      if (immediate) {
        await this.invoke(immediate.callback);
        immediate.handle.close();
        continue;
      }

      const hasPendingWork = this.nextTicks.length > 0
        || this.promiseJobs.length > 0
        || this.timers.some((entry) => this.liveness.refs.has(entry.handle.id))
        || this.immediates.some((entry) => this.liveness.refs.has(entry.handle.id));
      if (!hasPendingWork) break;

      if (this.timers.length > 0) {
        this.now = Math.min(...this.timers.map((entry) => entry.due));
        continue;
      }

      break;
    }

    return {
      exitCode: this.process.exitCode ?? 0,
      exited: this.process.exited,
      uncaughtException: this.process.uncaughtException
    };
  }

  async drainMicrotasks(): Promise<void> {
    while (!this.process.exited && (this.nextTicks.length > 0 || this.promiseJobs.length > 0)) {
      while (!this.process.exited && this.nextTicks.length > 0) {
        const callback = this.nextTicks.shift();
        if (callback) await this.invoke(callback);
      }
      while (!this.process.exited && this.nextTicks.length === 0 && this.promiseJobs.length > 0) {
        const callback = this.promiseJobs.shift();
        if (callback) await this.invoke(callback);
      }
    }
  }

  takeDueTimer(): ScheduledTimer | null {
    const due = this.timers
      .filter((entry) => entry.due <= this.now && this.liveness.refs.has(entry.handle.id))
      .sort((a, b) => a.due - b.due || a.sequence - b.sequence)[0];
    if (!due) return null;
    this.timers = this.timers.filter((entry) => entry !== due);
    return due;
  }

  async invoke(callback: RuntimeTaskCallback): Promise<void> {
    try {
      this.callbacksRun += 1;
      if (this.callbacksRun > this.maxCallbacksPerRun) throw new SchedulerLimitError(this.maxCallbacksPerRun);
      await callback();
      if (this.callbacksRun % this.yieldEveryCallbacks === 0) await yieldToHost();
    } catch (error) {
      this.process.captureUncaught(error);
    }
  }
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1) throw new RangeError(`${name} must be a positive safe integer`);
  return resolved;
}

function yieldToHost(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export function createScheduler(options: RuntimeSchedulerOptions = {}): RuntimeScheduler {
  return new RuntimeScheduler(options);
}
