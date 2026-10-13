export interface TimerOptions {
  ref?: boolean;
  signal?: AbortSignal;
}

export function setTimeoutPromise<T = void>(delay = 1, value?: T, options: TimerOptions = {}): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(options.signal.reason);
      return;
    }

    const timeout = setTimeout(() => {
      cleanup();
      resolve(value as T);
    }, delay);

    const cleanup = () => options.signal?.removeEventListener("abort", onAbort);
    const onAbort = () => {
      clearTimeout(timeout);
      cleanup();
      reject(options.signal?.reason);
    };

    options.signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export const timersPromisesBuiltin = Object.freeze({
  setTimeout: setTimeoutPromise
});
