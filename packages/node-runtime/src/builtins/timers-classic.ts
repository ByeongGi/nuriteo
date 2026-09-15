type ImmediateHandle = ReturnType<typeof setTimeout>;

const setImmediateFallback =
  globalThis.setImmediate ||
  ((callback: (...args: unknown[]) => void, ...args: unknown[]): ImmediateHandle => setTimeout(callback, 0, ...args));

const clearImmediateFallback =
  globalThis.clearImmediate ||
  ((handle: ImmediateHandle): void => {
    clearTimeout(handle);
  });

export const timersBuiltin = Object.freeze({
  clearImmediate: clearImmediateFallback,
  clearInterval,
  clearTimeout,
  default: {
    clearImmediate: clearImmediateFallback,
    clearInterval,
    clearTimeout,
    setImmediate: setImmediateFallback,
    setInterval,
    setTimeout
  },
  setImmediate: setImmediateFallback,
  setInterval,
  setTimeout
});
