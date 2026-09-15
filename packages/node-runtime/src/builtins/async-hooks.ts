export class AsyncLocalStorage<T = unknown> {
  #store: T | undefined;

  disable(): void {
    this.#store = undefined;
  }

  enterWith(store: T): void {
    this.#store = store;
  }

  exit<R, TArgs extends unknown[]>(callback: (...args: TArgs) => R, ...args: TArgs): R {
    const previous = this.#store;
    this.#store = undefined;
    try {
      return callback(...args);
    } finally {
      this.#store = previous;
    }
  }

  getStore(): T | undefined {
    return this.#store;
  }

  run<R, TArgs extends unknown[]>(store: T, callback: (...args: TArgs) => R, ...args: TArgs): R {
    const previous = this.#store;
    this.#store = store;
    try {
      return callback(...args);
    } finally {
      this.#store = previous;
    }
  }
}

export interface AsyncHook {
  disable(): AsyncHook;
  enable(): AsyncHook;
}

export interface AsyncHookCallbacks {
  after?(asyncId: number): void;
  before?(asyncId: number): void;
  destroy?(asyncId: number): void;
  init?(asyncId: number, type: string, triggerAsyncId: number, resource: unknown): void;
  promiseResolve?(asyncId: number): void;
}

export function createHook(_callbacks: AsyncHookCallbacks = {}): AsyncHook {
  return {
    disable() {
      return this;
    },
    enable() {
      return this;
    }
  };
}

export function executionAsyncId(): number {
  return 0;
}

export function triggerAsyncId(): number {
  return 0;
}

export const asyncHooksBuiltin = Object.freeze({
  AsyncLocalStorage,
  createHook,
  executionAsyncId,
  triggerAsyncId
});
