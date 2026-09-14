export function createTimerAdapters(scheduler) {
  return {
    setTimeout: (callback, delay) => scheduler.setTimeout(callback, delay),
    setImmediate: (callback) => scheduler.setImmediate(callback),
    queueMicrotask: (callback) => scheduler.queuePromiseJob(callback)
  };
}
