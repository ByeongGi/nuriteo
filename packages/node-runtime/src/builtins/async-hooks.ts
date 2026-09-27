export class AsyncLocalStorage<T = unknown> {
  static readonly #instances = new Set<AsyncLocalStorage<unknown>>();
  #store: T | undefined;

  constructor() {
    AsyncLocalStorage.#instances.add(this as AsyncLocalStorage<unknown>);
  }

  static bind<TFunction extends (...args: never[]) => unknown>(fn: TFunction): TFunction {
    return fn;
  }

  static snapshot(): <R, TArgs extends unknown[]>(callback: (...args: TArgs) => R, ...args: TArgs) => R {
    const captured = [...AsyncLocalStorage.#instances].map((storage) => [storage, storage.#store] as const);
    return function runInAsyncSnapshot<R, TArgs extends unknown[]>(callback: (...args: TArgs) => R, ...args: TArgs): R {
      const previous = captured.map(([storage]) => [storage, storage.#store] as const);
      for (const [storage, store] of captured) storage.#store = store;
      try {
        const result = callback(...args);
        if (isPromiseLike(result)) {
          // Browsers do not expose promise lifecycle hooks. Keep the captured
          // stores active for lazy work spawned by the returned promise; the
          // next explicit run/exit call establishes the following scope.
          return result;
        }
        for (const [storage, store] of previous) storage.#store = store;
        return result;
      } catch (error) {
        for (const [storage, store] of previous) storage.#store = store;
        throw error;
      }
    };
  }

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
      const result = callback(...args);
      if (isPromiseLike(result)) {
        return Promise.resolve(result).finally(() => {
          if (this.#store === undefined) this.#store = previous;
        }) as R;
      }
      this.#store = previous;
      return result;
    } catch (error) {
      this.#store = previous;
      throw error;
    }
  }

  getStore(): T | undefined {
    return this.#store;
  }

  run<R, TArgs extends unknown[]>(store: T, callback: (...args: TArgs) => R, ...args: TArgs): R {
    const previous = this.#store;
    this.#store = store;
    try {
      const result = callback(...args);
      if (isPromiseLike(result)) {
        // Async renderers can return a promise before all lazily-consumed work
        // has completed. Restoring here would erase that work's request scope.
        return result;
      }
      this.#store = previous;
      return result;
    } catch (error) {
      this.#store = previous;
      throw error;
    }
  }
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (typeof value === "object" || typeof value === "function")
    && value !== null
    && typeof (value as { then?: unknown }).then === "function";
}


export class AsyncResource {
  readonly type: string;

  constructor(type: string) {
    this.type = type;
  }

  asyncId(): number {
    return 0;
  }

  bind<T extends (...args: never[]) => unknown>(fn: T, thisArg?: unknown): T {
    return fn.bind(thisArg) as T;
  }

  emitDestroy(): this {
    return this;
  }

  runInAsyncScope<T, TArgs extends unknown[]>(fn: (...args: TArgs) => T, thisArg?: unknown, ...args: TArgs): T {
    return fn.apply(thisArg, args);
  }

  triggerAsyncId(): number {
    return 0;
  }

  static bind<T extends (...args: never[]) => unknown>(fn: T, type?: string, thisArg?: unknown): T {
    return new AsyncResource(type || fn.name || "bound-anonymous-fn").bind(fn, thisArg);
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
  AsyncResource,
  createHook,
  executionAsyncId,
  triggerAsyncId
});
