type Listener = (...args: unknown[]) => void;

export class EventEmitter {
  #events = new Map<string | symbol, Listener[]>();
  #maxListeners = 10;

  on(eventName: string | symbol, listener: Listener): this {
    return this.addListener(eventName, listener);
  }

  addListener(eventName: string | symbol, listener: Listener): this {
    const listeners = this.#events.get(eventName) || [];
    listeners.push(listener);
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
    return this.removeListener(eventName, listener);
  }

  removeListener(eventName: string | symbol, listener: Listener): this {
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

export const eventsBuiltin = Object.freeze({
  EventEmitter,
  once,
  default: EventEmitter
});
