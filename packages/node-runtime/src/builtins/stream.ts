import { EventEmitter } from "./events.ts";
import type { RuntimeValue } from "../types.ts";

type StreamCallback = (error?: Error | null) => void;
type WriteCallback = (error?: Error | null) => void;
type TransformCallback = (error?: Error | null, data?: RuntimeValue) => void;
type Listener = (...args: unknown[]) => void;

export interface WritableOptions {
  write?: (chunk: RuntimeValue, encoding: string, callback: WriteCallback) => void;
  final?: (callback: StreamCallback) => void;
}

export interface TransformOptions extends WritableOptions {
  transform?: (chunk: RuntimeValue, encoding: string, callback: TransformCallback) => void;
  flush?: (callback: TransformCallback) => void;
}

export class Stream extends EventEmitter {
  pipe<T extends Writable>(destination: T): T {
    const onData = (chunk: RuntimeValue) => {
      destination.write(chunk);
    };
    const onEnd = () => {
      destination.end();
    };
    this.on("data", onData);
    this.once("end", onEnd);
    destination.emit("pipe", this);
    return destination;
  }

  unpipe(destination?: Writable): this {
    if (destination) destination.emit("unpipe", this);
    return this;
  }
}

export class Readable extends Stream {
  #queue: RuntimeValue[] = [];
  #ended = false;
  #destroyed = false;
  #encoding: BufferEncoding | null = null;

  static from(iterable: Iterable<RuntimeValue> | AsyncIterable<RuntimeValue>): Readable {
    const readable = new Readable();
    queueMicrotask(async () => {
      try {
        for await (const chunk of iterable) readable.push(chunk);
        readable.push(null);
      } catch (error) {
        readable.destroy(error);
      }
    });
    return readable;
  }

  get readableEnded(): boolean {
    return this.#ended;
  }

  get destroyed(): boolean {
    return this.#destroyed;
  }

  push(chunk: RuntimeValue): boolean {
    if (chunk === null) {
      this.#ended = true;
      this.emit("end");
      this.emit("close");
      return false;
    }
    const value = this.#encoding && chunk instanceof Uint8Array ? new TextDecoder(this.#encoding).decode(chunk) : chunk;
    this.#queue.push(value);
    this.emit("data", value);
    return true;
  }

  override pipe<T extends Writable>(destination: T): T {
    super.pipe(destination);
    while (this.#queue.length > 0) destination.write(this.#queue.shift());
    if (this.#ended) destination.end();
    return destination;
  }

  setEncoding(encoding: BufferEncoding): this {
    this.#encoding = encoding;
    return this;
  }

  read(): RuntimeValue {
    return this.#queue.shift() ?? null;
  }

  destroy(error?: RuntimeValue): this {
    this.#destroyed = true;
    if (error) this.emit("error", error);
    this.emit("close");
    return this;
  }

  async *[Symbol.asyncIterator](): AsyncIterableIterator<RuntimeValue> {
    while (!this.#destroyed) {
      while (this.#queue.length > 0) yield this.#queue.shift();
      if (this.#ended) return;
      const event = await waitReadableEvent(this);
      if (event.kind === "data") continue;
      if (event.kind === "end") return;
      if (event.kind === "error") throw event.error;
    }
  }
}

export class Writable extends Stream {
  #options: WritableOptions;
  #ended = false;
  #destroyed = false;

  constructor(options: WritableOptions = {}) {
    super();
    this.#options = options;
  }

  get writableEnded(): boolean {
    return this.#ended;
  }

  get destroyed(): boolean {
    return this.#destroyed;
  }

  write(chunk: RuntimeValue, encodingOrCallback: string | WriteCallback = "utf8", callback?: WriteCallback): boolean {
    const encoding = typeof encodingOrCallback === "string" ? encodingOrCallback : "utf8";
    const done = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
    try {
      this._write(chunk, encoding, (error) => {
        if (error) this.destroy(error);
        done?.(error);
      });
      return true;
    } catch (error) {
      this.destroy(error);
      done?.(asError(error));
      return false;
    }
  }

  end(chunkOrCallback?: RuntimeValue | StreamCallback, encodingOrCallback?: string | StreamCallback, callback?: StreamCallback): this {
    const chunk = typeof chunkOrCallback === "function" ? undefined : chunkOrCallback;
    const done = typeof chunkOrCallback === "function"
      ? chunkOrCallback
      : typeof encodingOrCallback === "function"
        ? encodingOrCallback
        : callback;
    if (chunk !== undefined) this.write(chunk);
    this._final((error) => {
      if (error) {
        this.destroy(error);
        done?.(error);
        return;
      }
      this.#ended = true;
      this.emit("finish");
      this.emit("close");
      done?.();
    });
    return this;
  }

  destroy(error?: RuntimeValue): this {
    this.#destroyed = true;
    if (error) this.emit("error", error);
    this.emit("close");
    return this;
  }

  protected _write(chunk: RuntimeValue, encoding: string, callback: WriteCallback): void {
    if (this.#options.write) this.#options.write.call(this, chunk, encoding, callback);
    else callback();
  }

  protected _final(callback: StreamCallback): void {
    if (this.#options.final) this.#options.final.call(this, callback);
    else callback();
  }
}

export class Duplex extends Readable {
  #writable = new Writable();

  get writableEnded(): boolean {
    return this.#writable.writableEnded;
  }

  write(chunk: RuntimeValue, encodingOrCallback?: string | WriteCallback, callback?: WriteCallback): boolean {
    return this.#writable.write(chunk, encodingOrCallback ?? "utf8", callback);
  }

  end(chunkOrCallback?: RuntimeValue | StreamCallback, encodingOrCallback?: string | StreamCallback, callback?: StreamCallback): this {
    this.#writable.end(chunkOrCallback, encodingOrCallback, callback);
    this.push(null);
    return this;
  }
}

export class Transform extends Duplex {
  #options: TransformOptions;

  constructor(options: TransformOptions = {}) {
    super();
    this.#options = options;
  }

  write(chunk: RuntimeValue, encodingOrCallback: string | WriteCallback = "utf8", callback?: WriteCallback): boolean {
    const encoding = typeof encodingOrCallback === "string" ? encodingOrCallback : "utf8";
    const done = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
    this._transform(chunk, encoding, (error, data) => {
      if (error) {
        this.destroy(error);
        done?.(error);
        return;
      }
      if (data !== undefined) this.push(data);
      done?.();
    });
    return true;
  }

  end(chunkOrCallback?: RuntimeValue | StreamCallback, encodingOrCallback?: string | StreamCallback, callback?: StreamCallback): this {
    const chunk = typeof chunkOrCallback === "function" ? undefined : chunkOrCallback;
    const done = typeof chunkOrCallback === "function"
      ? chunkOrCallback
      : typeof encodingOrCallback === "function"
        ? encodingOrCallback
        : callback;
    if (chunk !== undefined) this.write(chunk);
    this._flush((error, data) => {
      if (error) {
        this.destroy(error);
        done?.(error);
        return;
      }
      if (data !== undefined) this.push(data);
      this.push(null);
      done?.();
    });
    return this;
  }

  protected _transform(chunk: RuntimeValue, encoding: string, callback: TransformCallback): void {
    if (this.#options.transform) this.#options.transform.call(this, chunk, encoding, callback);
    else callback(null, chunk);
  }

  protected _flush(callback: TransformCallback): void {
    if (this.#options.flush) this.#options.flush.call(this, callback);
    else callback();
  }
}

export class PassThrough extends Transform {}

export function pipeline(...args: Array<Readable | Writable | Transform | Duplex | StreamCallback>): Writable | Transform | Duplex | Promise<void> {
  const callback = typeof args.at(-1) === "function" ? args.pop() as StreamCallback : undefined;
  const streams = args as Array<Readable | Writable | Transform | Duplex>;
  for (let index = 0; index < streams.length - 1; index += 1) {
    streams[index]?.pipe(streams[index + 1] as Writable);
  }
  const last = streams.at(-1);
  if (!last) throw new TypeError("pipeline requires at least one stream");
  const promise = waitForCompletion(last);
  if (callback) {
    promise.then(() => callback(), callback);
    return last as Writable | Transform | Duplex;
  }
  return promise;
}

export function finished(stream: EventEmitter, callback?: StreamCallback): Promise<void> | EventEmitter {
  const promise = waitForCompletion(stream);
  if (callback) {
    promise.then(() => callback(), callback);
    return stream;
  }
  return promise;
}

export const promises = Object.freeze({
  finished: (stream: EventEmitter) => waitForCompletion(stream),
  pipeline: (...streams: Array<Readable | Writable | Transform | Duplex>) => pipeline(...streams) as Promise<void>
});

const legacyStream = createLegacyStreamConstructor();

export const streamBuiltin = Object.assign(legacyStream, {
  Duplex,
  PassThrough,
  Readable,
  Stream: legacyStream,
  Transform,
  Writable,
  default: legacyStream,
  finished,
  pipeline,
  promises
});

export const streamPromisesBuiltin = Object.freeze({
  finished: promises.finished,
  pipeline: promises.pipeline
});

function waitReadableEvent(stream: Readable): Promise<
  | { kind: "data"; chunk: RuntimeValue }
  | { kind: "end" }
  | { kind: "error"; error: Error }
> {
  return new Promise((resolve) => {
    const cleanup = () => {
      stream.off("data", onData);
      stream.off("end", onEnd);
      stream.off("error", onError);
    };
    const onData = (chunk: RuntimeValue) => {
      cleanup();
      resolve({ kind: "data", chunk });
    };
    const onEnd = () => {
      cleanup();
      resolve({ kind: "end" });
    };
    const onError = (error: RuntimeValue) => {
      cleanup();
      resolve({ kind: "error", error: asError(error) });
    };
    stream.once("data", onData);
    stream.once("end", onEnd);
    stream.once("error", onError);
  });
}

function waitForCompletion(stream: EventEmitter): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      stream.off("finish", onDone);
      stream.off("end", onDone);
      stream.off("close", onDone);
      stream.off("error", onError);
    };
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };
    const onDone = () => settle(resolve);
    const onError = (error: RuntimeValue) => settle(() => reject(asError(error)));
    stream.once("finish", onDone);
    stream.once("end", onDone);
    stream.once("close", onDone);
    stream.once("error", onError);
  });
}

function asError(error: RuntimeValue): Error {
  return error instanceof Error ? error : new Error(String(error ?? "Stream error"));
}

function createLegacyStreamConstructor(): typeof Stream {
  const listeners = new WeakMap<object, Map<string | symbol, Listener[]>>();

  function getListeners(target: object, eventName: string | symbol): Listener[] {
    let events = listeners.get(target);
    if (!events) {
      events = new Map();
      listeners.set(target, events);
    }
    const eventListeners = events.get(eventName) || [];
    events.set(eventName, eventListeners);
    return eventListeners;
  }

  const LegacyStream = function Stream() {
    return undefined;
  } as unknown as typeof Stream;

  LegacyStream.prototype.on = function on(eventName: string | symbol, listener: Listener) {
    getListeners(this, eventName).push(listener);
    return this;
  };
  LegacyStream.prototype.addListener = LegacyStream.prototype.on;
  LegacyStream.prototype.once = function once(eventName: string | symbol, listener: Listener) {
    const onceListener: Listener & { listener?: Listener } = (...args) => {
      this.removeListener(eventName, onceListener);
      listener.apply(this, args);
    };
    onceListener.listener = listener;
    return this.on(eventName, onceListener);
  };
  LegacyStream.prototype.emit = function emit(eventName: string | symbol, ...args: unknown[]) {
    const eventListeners = [...getListeners(this, eventName)];
    if (eventListeners.length === 0 && eventName === "error") throw asError(args[0]);
    for (const listener of eventListeners) listener.apply(this, args);
    return eventListeners.length > 0;
  };
  LegacyStream.prototype.listeners = function listenersFor(eventName: string | symbol) {
    return [...getListeners(this, eventName)].map((listener) => (listener as Listener & { listener?: Listener }).listener || listener);
  };
  LegacyStream.prototype.listenerCount = function listenerCount(eventName: string | symbol) {
    return getListeners(this, eventName).length;
  };
  LegacyStream.prototype.off = function off(eventName: string | symbol, listener: Listener) {
    return this.removeListener(eventName, listener);
  };
  LegacyStream.prototype.removeListener = function removeListener(eventName: string | symbol, listener: Listener) {
    const eventListeners = getListeners(this, eventName);
    const next = eventListeners.filter((item) => item !== listener && (item as Listener & { listener?: Listener }).listener !== listener);
    eventListeners.splice(0, eventListeners.length, ...next);
    return this;
  };
  LegacyStream.prototype.removeAllListeners = function removeAllListeners(eventName?: string | symbol) {
    if (eventName === undefined) listeners.get(this)?.clear();
    else listeners.get(this)?.delete(eventName);
    return this;
  };
  LegacyStream.prototype.pipe = Stream.prototype.pipe;
  LegacyStream.prototype.unpipe = Stream.prototype.unpipe;
  return LegacyStream;
}
