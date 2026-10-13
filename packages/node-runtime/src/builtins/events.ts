type Listener = (...args: unknown[]) => void;
type EventMap = Map<string | symbol, Listener[]>;

export class EventEmitter {
  #events = new Map<string | symbol, Listener[]>();
  #maxListeners = 10;

  on(eventName: string | symbol, listener: Listener): this {
    return this.#addListener(eventName, listener, "append");
  }

  addListener(eventName: string | symbol, listener: Listener): this {
    return this.#addListener(eventName, listener, "append");
  }

  prependListener(eventName: string | symbol, listener: Listener): this {
    return this.#addListener(eventName, listener, "prepend");
  }

  #addListener(eventName: string | symbol, listener: Listener, placement: "append" | "prepend"): this {
    if (eventName !== "newListener") this.emit("newListener", eventName, listener);
    const listeners = this.#events.get(eventName) || [];
    if (placement === "prepend") listeners.unshift(listener);
    else listeners.push(listener);
    this.#events.set(eventName, listeners);
    return this;
  }

  once(eventName: string | symbol, listener: Listener): this {
    const onceListener: Listener & { listener?: Listener } = (...args) => {
      this.removeListener(eventName, onceListener);
      listener.apply(this, args);
    };
    onceListener.listener = listener;
    return this.addListener(eventName, onceListener);
  }

  prependOnceListener(eventName: string | symbol, listener: Listener): this {
    const onceListener: Listener & { listener?: Listener } = (...args) => {
      this.removeListener(eventName, onceListener);
      listener.apply(this, args);
    };
    onceListener.listener = listener;
    return this.prependListener(eventName, onceListener);
  }

  emit(eventName: string | symbol, ...args: unknown[]): boolean {
    const listeners = [...(this.#events.get(eventName) || [])];
    if (listeners.length === 0) {
      if (eventName === "error") {
        const error = args[0];
        throw error instanceof Error ? error : new Error(String(error || "Unhandled error event"));
      }
      return false;
    }
    for (const listener of listeners) listener.apply(this, args);
    return true;
  }

  off(eventName: string | symbol, listener: Listener): this {
    return this.#removeListener(eventName, listener);
  }

  removeListener(eventName: string | symbol, listener: Listener): this {
    return this.#removeListener(eventName, listener);
  }

  #removeListener(eventName: string | symbol, listener: Listener): this {
    const listeners = this.#events.get(eventName);
    if (!listeners) return this;
    const next = listeners.filter((item) => item !== listener && (item as Listener & { listener?: Listener }).listener !== listener);
    if (next.length === 0) this.#events.delete(eventName);
    else this.#events.set(eventName, next);
    return this;
  }

  removeAllListeners(eventName?: string | symbol): this {
    if (eventName === undefined) this.#events.clear();
    else this.#events.delete(eventName);
    return this;
  }

  listeners(eventName: string | symbol): Listener[] {
    return [...(this.#events.get(eventName) || [])].map((listener) => (listener as Listener & { listener?: Listener }).listener || listener);
  }

  listenerCount(eventName: string | symbol): number {
    return this.#events.get(eventName)?.length || 0;
  }

  setMaxListeners(count: number): this {
    this.#maxListeners = count;
    return this;
  }

  getMaxListeners(): number {
    return this.#maxListeners;
  }

  static listenerCount(emitter: EventEmitter, eventName: string | symbol): number {
    return emitter.listenerCount(eventName);
  }
}

export function once(emitter: EventEmitter, eventName: string | symbol): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    emitter.once(eventName, (...args) => resolve(args));
    if (eventName !== "error") emitter.once("error", (error) => reject(error));
  });
}

const legacyEventEmitter = createLegacyEventEmitterConstructor();

export const eventsBuiltin = Object.assign(legacyEventEmitter, {
  EventEmitter: legacyEventEmitter,
  once,
  default: legacyEventEmitter
});

function createLegacyEventEmitterConstructor(): typeof EventEmitter {
  const events = new WeakMap<object, EventMap>();
  const maxListeners = new WeakMap<object, number>();

  function getEventMap(target: object): EventMap {
    let map = events.get(target);
    if (!map) {
      map = new Map();
      events.set(target, map);
    }
    return map;
  }

  function getListeners(target: object, eventName: string | symbol): Listener[] {
    const map = getEventMap(target);
    const listeners = map.get(eventName) || [];
    map.set(eventName, listeners);
    return listeners;
  }

  const LegacyEventEmitter = function EventEmitter() {
    return undefined;
  } as unknown as typeof EventEmitter;
  Object.defineProperty(LegacyEventEmitter, Symbol.hasInstance, {
    value(value: unknown) {
      return value instanceof EventEmitter ||
        (typeof value === "object" &&
          value !== null &&
          typeof (value as { on?: unknown }).on === "function" &&
          typeof (value as { emit?: unknown }).emit === "function");
    }
  });

  LegacyEventEmitter.listenerCount = (emitter: EventEmitter, eventName: string | symbol) => emitter.listenerCount(eventName);
  const addListenerWithPlacement = function addListenerWithPlacement(
    target: EventEmitter,
    eventName: string | symbol,
    listener: Listener,
    placement: "append" | "prepend"
  ) {
    if (eventName !== "newListener") target.emit("newListener", eventName, listener);
    const listeners = getListeners(target, eventName);
    if (placement === "prepend") listeners.unshift(listener);
    else listeners.push(listener);
    return target;
  };
  const addListener = function addListener(this: EventEmitter, eventName: string | symbol, listener: Listener) {
    addListenerWithPlacement(this, eventName, listener, "append");
    return this;
  };
  LegacyEventEmitter.prototype.on = addListener;
  LegacyEventEmitter.prototype.addListener = addListener;
  LegacyEventEmitter.prototype.prependListener = function prependListener(eventName: string | symbol, listener: Listener) {
    return addListenerWithPlacement(this, eventName, listener, "prepend");
  };
  LegacyEventEmitter.prototype.once = function once(eventName: string | symbol, listener: Listener) {
    const onceListener: Listener & { listener?: Listener } = (...args) => {
      this.removeListener(eventName, onceListener);
      listener.apply(this, args);
    };
    onceListener.listener = listener;
    return this.addListener(eventName, onceListener);
  };
  LegacyEventEmitter.prototype.prependOnceListener = function prependOnceListener(eventName: string | symbol, listener: Listener) {
    const onceListener: Listener & { listener?: Listener } = (...args) => {
      this.removeListener(eventName, onceListener);
      listener.apply(this, args);
    };
    onceListener.listener = listener;
    return this.prependListener(eventName, onceListener);
  };
  LegacyEventEmitter.prototype.emit = function emit(eventName: string | symbol, ...args: unknown[]) {
    const listeners = [...getListeners(this, eventName)];
    if (listeners.length === 0) {
      if (eventName === "error") {
        const error = args[0];
        throw error instanceof Error ? error : new Error(String(error || "Unhandled error event"));
      }
      return false;
    }
    for (const listener of listeners) listener.apply(this, args);
    return true;
  };
  const removeListener = function removeListener(this: EventEmitter, eventName: string | symbol, listener: Listener) {
    const listeners = getListeners(this, eventName);
    const next = listeners.filter((item) => item !== listener && (item as Listener & { listener?: Listener }).listener !== listener);
    listeners.splice(0, listeners.length, ...next);
    return this;
  };
  LegacyEventEmitter.prototype.off = removeListener;
  LegacyEventEmitter.prototype.removeListener = removeListener;
  LegacyEventEmitter.prototype.removeAllListeners = function removeAllListeners(eventName?: string | symbol) {
    if (eventName === undefined) getEventMap(this).clear();
    else getEventMap(this).delete(eventName);
    return this;
  };
  LegacyEventEmitter.prototype.listeners = function listenersFor(eventName: string | symbol) {
    return [...getListeners(this, eventName)].map((listener) => (listener as Listener & { listener?: Listener }).listener || listener);
  };
  LegacyEventEmitter.prototype.listenerCount = function listenerCount(eventName: string | symbol) {
    return getListeners(this, eventName).length;
  };
  LegacyEventEmitter.prototype.setMaxListeners = function setMaxListeners(count: number) {
    maxListeners.set(this, count);
    return this;
  };
  LegacyEventEmitter.prototype.getMaxListeners = function getMaxListeners() {
    return maxListeners.get(this) ?? 10;
  };
  return LegacyEventEmitter;
}
