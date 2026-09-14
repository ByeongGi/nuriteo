import { LivenessTracker } from "./liveness.ts";
import { RuntimeProcess } from "./process.ts";
import type { LivenessHandle, RuntimeTaskCallback } from "./types.ts";

interface RuntimeSchedulerOptions {
  process?: RuntimeProcess;
  liveness?: LivenessTracker;
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

  constructor(options: RuntimeSchedulerOptions = {}) {
    this.process = options.process || new RuntimeProcess();
    this.liveness = options.liveness || new LivenessTracker();
    this.nextTicks = [];
    this.promiseJobs = [];
    this.timers = [];
    this.immediates = [];
    this.now = 0;
    this.sequence = 0;
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
      await callback();
    } catch (error) {
      this.process.captureUncaught(error);
    }
  }
}

export function createScheduler(options: RuntimeSchedulerOptions = {}): RuntimeScheduler {
  return new RuntimeScheduler(options);
}
