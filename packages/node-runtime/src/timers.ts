import type { RuntimeScheduler } from "./scheduler.ts";
import type { RuntimeTaskCallback } from "./types.ts";

export function createTimerAdapters(scheduler: RuntimeScheduler): {
  setTimeout: (callback: RuntimeTaskCallback, delay?: number) => ReturnType<RuntimeScheduler["setTimeout"]>;
  setImmediate: (callback: RuntimeTaskCallback) => ReturnType<RuntimeScheduler["setImmediate"]>;
  queueMicrotask: (callback: RuntimeTaskCallback) => void;
} {
  return {
    setTimeout: (callback, delay) => scheduler.setTimeout(callback, delay),
    setImmediate: (callback) => scheduler.setImmediate(callback),
    queueMicrotask: (callback) => scheduler.queuePromiseJob(callback)
  };
}
