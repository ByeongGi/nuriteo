import { EventEmitter } from "./events.ts";
import { BrowserBuffer } from "./buffer.ts";
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
  readable = true;
  __browserReadableQueue: RuntimeValue[];
  __browserReadableEnded = false;
  __browserReadableEndEmitted = false;
  _readableState: { encoding: BufferEncoding | null; highWaterMark: number; objectMode: boolean } = {
    encoding: null,
    highWaterMark: 16 * 1024,
    objectMode: false
  };
  #queue: RuntimeValue[] = [];
  #ended = false;
  #endEmitted = false;
  #destroyed = false;
  #encoding: BufferEncoding | null = null;
  #readScheduled = false;

  constructor(options: { highWaterMark?: number; objectMode?: boolean } = {}) {
    super();
    this.__browserReadableQueue = this.#queue;
    this._readableState.objectMode = options.objectMode === true;
    if (typeof options.highWaterMark === "number") this._readableState.highWaterMark = options.highWaterMark;
  }

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
      this.__browserReadableEnded = true;
      this.readable = false;
      this.#scheduleRead();
      return false;
    }
    const value = normalizeReadableChunk(chunk, this.#encoding);
    if (this.listenerCount("data") > 0) {
      this.emit("data", value);
      this.#scheduleRead();
    }
    else {
      this.#queue.push(value);
      if (this.listenerCount("readable") > 0) this.#scheduleRead();
    }
    return true;
  }

  override pipe<T extends Writable>(destination: T): T {
    super.pipe(destination);
    while (this.#queue.length > 0) destination.write(this.#queue.shift());
    this.#scheduleRead();
    return destination;
  }

  setEncoding(encoding: BufferEncoding): this {
    this.#encoding = encoding;
    this._readableState.encoding = encoding;
    return this;
  }

  read(): RuntimeValue {
    this.#scheduleRead();
    return this.#queue.shift() ?? null;
  }

  override on(eventName: string | symbol, listener: Listener): this {
    super.on(eventName, listener);
    if (eventName === "data" || eventName === "end" || eventName === "readable") this.#scheduleRead();
    return this;
  }

  override addListener(eventName: string | symbol, listener: Listener): this {
    return this.on(eventName, listener);
  }

  override once(eventName: string | symbol, listener: Listener): this {
    super.once(eventName, listener);
    if (eventName === "data" || eventName === "end" || eventName === "readable") this.#scheduleRead();
    return this;
  }

  destroy(error?: RuntimeValue): this {
    this.#destroyed = true;
    this.readable = false;
    if (error) this.emit("error", error);
    this.emit("close");
    return this;
  }

  protected _read(_size?: number): void {}

  #scheduleRead(): void {
    if (this.#readScheduled || this.#destroyed) return;
    this.#readScheduled = true;
    queueMicrotask(() => {
      this.#readScheduled = false;
      if (this.#destroyed) return;
      try {
        while (this.#queue.length > 0 && this.listenerCount("data") > 0) {
          this.emit("data", this.#queue.shift());
        }
        if (this.#queue.length > 0 && this.listenerCount("readable") > 0) this.emit("readable");
        if (this.#ended && this.#queue.length === 0 && this.listenerCount("end") > 0) this.#emitEnd();
        if (!this.#ended) void this._read(4096);
      } catch (error) {
        this.destroy(error);
      }
    });
  }

  #emitEnd(): void {
    if (this.#endEmitted) return;
    this.#endEmitted = true;
    this.__browserReadableEndEmitted = true;
    this.emit("end");
    this.emit("close");
  }

  async *[Symbol.asyncIterator](): AsyncIterableIterator<RuntimeValue> {
    while (!this.#destroyed) {
      const replacementState = this as unknown as Partial<LegacyTransformState>;
      const queue = replacementState.__browserReadableQueue ?? this.#queue;
      while (queue.length > 0) yield queue.shift();
      if (replacementState.__browserReadableEnded === true || this.#ended) return;
      const event = await waitReadableEvent(this);
      if (event.kind === "data") {
        yield event.chunk;
        continue;
      }
      if (event.kind === "end") return;
      if (event.kind === "error") throw event.error;
    }
  }
}

export class Writable extends Stream {
  writable = true;
  _writableState: { objectMode: boolean } = {
    objectMode: false
  };
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
      this.writable = false;
      this.emit("finish");
      this.emit("close");
      done?.();
    });
    return this;
  }

  destroy(error?: RuntimeValue): this {
    this.#destroyed = true;
    this.writable = false;
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
  writable = true;
  #writable = new Writable();

  get writableEnded(): boolean {
    return this.#writable.writableEnded;
  }

  write(chunk: RuntimeValue, encodingOrCallback?: string | WriteCallback, callback?: WriteCallback): boolean {
    return this.#writable.write(chunk, encodingOrCallback ?? "utf8", callback);
  }

  end(chunkOrCallback?: RuntimeValue | StreamCallback, encodingOrCallback?: string | StreamCallback, callback?: StreamCallback): this {
    if (!this.writable) return this;
    this.#writable.end(chunkOrCallback, encodingOrCallback, callback);
    this.writable = false;
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
    if (!this.writable) return this;
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
      this.writable = false;
      this.emit("finish");
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
const legacyReadable = createLegacyReadableConstructor();
const legacyTransform = createLegacyTransformConstructor(legacyStream);

export const streamBuiltin = Object.assign(legacyStream, {
  Duplex,
  PassThrough,
  Readable: legacyReadable,
  Stream: legacyStream,
  Transform: legacyTransform,
  Writable,
  default: legacyStream,
  finished,
  isDisturbed: (stream: RuntimeValue): boolean => Boolean(
    stream && typeof stream === "object" && (
      (stream as { locked?: boolean }).locked === true
      || (stream as { readableEnded?: boolean }).readableEnded === true
    )
  ),
  pipeline,
  promises
});

export const streamPromisesBuiltin = Object.freeze({
  finished: promises.finished,
  pipeline: promises.pipeline
});

const webStreamsGlobal = globalThis as unknown as Record<string, unknown>;
export const streamWebBuiltin = Object.freeze(Object.fromEntries([
  "ByteLengthQueuingStrategy",
  "CompressionStream",
  "CountQueuingStrategy",
  "DecompressionStream",
  "ReadableByteStreamController",
  "ReadableStream",
  "ReadableStreamBYOBReader",
  "ReadableStreamBYOBRequest",
  "ReadableStreamDefaultController",
  "ReadableStreamDefaultReader",
  "TextDecoderStream",
  "TextEncoderStream",
  "TransformStream",
  "TransformStreamDefaultController",
  "WritableStream",
  "WritableStreamDefaultController",
  "WritableStreamDefaultWriter"
].map((name) => [name, webStreamsGlobal[name]])));

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

function normalizeReadableChunk(chunk: RuntimeValue, encoding: BufferEncoding | null): RuntimeValue {
  if (encoding && chunk instanceof Uint8Array) return new TextDecoder(encoding).decode(chunk);
  if (chunk instanceof Uint8Array && typeof (chunk as { copy?: unknown }).copy !== "function") {
    return BrowserBuffer.from(chunk);
  }
  return chunk;
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
  Object.defineProperty(LegacyStream, Symbol.hasInstance, {
    value(value: unknown) {
      return value instanceof Stream;
    }
  });

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

function createLegacyReadableConstructor(): typeof Readable {
  const LegacyReadable = function ReadableConstructor(this: Readable, options: { highWaterMark?: number; objectMode?: boolean } = {}) {
    const target = this as unknown as Record<string, unknown>;
    const inheritedRead = typeof target._read === "function" ? target._read as (size?: number) => void : undefined;
    const delegate = new Readable(options);
    if (inheritedRead) {
      (delegate as unknown as Record<string, unknown>)._read = (size?: number) => inheritedRead.call(target, size);
    }
    bindLegacyReadable(target, delegate);
    return target;
  } as unknown as typeof Readable;
  LegacyReadable.prototype = Readable.prototype;
  Object.setPrototypeOf(LegacyReadable, Readable);
  return LegacyReadable;
}

function bindLegacyReadable(target: Record<string, unknown>, delegate: Readable): void {
  for (const name of Reflect.ownKeys(delegate)) {
    Object.defineProperty(target, name, {
      configurable: true,
      enumerable: true,
      get: () => Reflect.get(delegate, name),
      set: (value) => { Reflect.set(delegate, name, value); }
    });
  }
  let prototype = Readable.prototype as object | null;
  while (prototype && prototype !== Object.prototype) {
    for (const name of Reflect.ownKeys(prototype)) {
      if (name === "constructor" || Object.hasOwn(target, name)) continue;
      const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
      if (typeof descriptor?.value === "function") {
        Object.defineProperty(target, name, {
          configurable: true,
          value: descriptor.value.bind(delegate),
          writable: true
        });
      } else if (descriptor?.get || descriptor?.set) {
        Object.defineProperty(target, name, {
          configurable: true,
          ...(descriptor.get ? { get: descriptor.get.bind(delegate) } : {}),
          ...(descriptor.set ? { set: descriptor.set.bind(delegate) } : {})
        });
      }
    }
    prototype = Object.getPrototypeOf(prototype);
  }
}

function createLegacyTransformConstructor(LegacyStream: typeof Stream): typeof Transform {
  const readableEncoding = new WeakMap<object, BufferEncoding | null>();

  const LegacyTransform = function Transform(this: Transform, options: TransformOptions = {}) {
    Object.defineProperties(this, {
      _readableState: {
        configurable: true,
        value: { encoding: null, objectMode: false },
        writable: true
      },
      _writableState: {
        configurable: true,
        value: { objectMode: false },
        writable: true
      },
      readable: {
        configurable: true,
        value: true,
        writable: true
      },
      writable: {
        configurable: true,
        value: true,
        writable: true
      },
      __browserReadableQueue: {
        configurable: true,
        enumerable: true,
        value: [],
        writable: true
      },
      __browserReadableEnded: {
        configurable: true,
        enumerable: true,
        value: false,
        writable: true
      },
      __browserReadableEndEmitted: {
        configurable: true,
        enumerable: true,
        value: false,
        writable: true
      }
    });
    Object.defineProperty(this, "__browserTransformOptions", {
      configurable: true,
      value: options,
      writable: true
    });
    readableEncoding.set(this, null);
  } as unknown as typeof Transform;

  LegacyTransform.prototype = Object.create(LegacyStream.prototype) as Transform;
  LegacyTransform.prototype.constructor = LegacyTransform;
  Object.defineProperty(LegacyTransform, Symbol.hasInstance, {
    value(value: unknown) {
      return value instanceof Transform ||
        (typeof value === "object" &&
          value !== null &&
          typeof (value as { pipe?: unknown }).pipe === "function" &&
          typeof (value as { write?: unknown }).write === "function");
    }
  });

  LegacyTransform.prototype.push = function push(this: Transform & LegacyTransformState, chunk: RuntimeValue): boolean {
    if (chunk === null) {
      this.readable = false;
      this.__browserReadableEnded = true;
      scheduleLegacyReadableFlush(this);
      return false;
    }
    const value = normalizeReadableChunk(chunk, readableEncoding.get(this) ?? null);
    if (this.listenerCount("data") > 0) this.emit("data", value);
    else this.__browserReadableQueue.push(value);
    return true;
  };
  LegacyTransform.prototype.on = function on(this: Transform & LegacyTransformState, eventName: string | symbol, listener: Listener) {
    LegacyStream.prototype.on.call(this, eventName, listener);
    if (eventName === "data" || eventName === "end") scheduleLegacyReadableFlush(this);
    return this;
  };
  LegacyTransform.prototype.addListener = LegacyTransform.prototype.on;
  LegacyTransform.prototype[Symbol.asyncIterator] = async function* asyncIterator(
    this: Transform & LegacyTransformState
  ): AsyncIterableIterator<RuntimeValue> {
    while (true) {
      while (this.__browserReadableQueue.length > 0) yield this.__browserReadableQueue.shift();
      if (this.__browserReadableEnded) return;
      const event = await waitReadableEvent(this);
      if (event.kind === "data") {
        yield event.chunk;
        continue;
      }
      if (event.kind === "end") return;
      throw event.error;
    }
  };
  LegacyTransform.prototype.write = function write(
    this: Transform & LegacyTransformState,
    chunk: RuntimeValue,
    encodingOrCallback: string | WriteCallback = "utf8",
    callback?: WriteCallback
  ): boolean {
    const encoding = typeof encodingOrCallback === "string" ? encodingOrCallback : "utf8";
    const done = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
    const transform = this._transform ?? this.__browserTransformOptions?.transform;
    const finish = (error?: Error | null, data?: RuntimeValue) => {
      if (error) {
        this.destroy(error);
        done?.(error);
        return;
      }
      if (data !== undefined) this.push(data);
      done?.();
    };
    if (transform) transform.call(this, chunk, encoding, finish);
    else finish(null, chunk);
    return true;
  };
  LegacyTransform.prototype.end = function end(
    this: Transform & LegacyTransformState,
    chunkOrCallback?: RuntimeValue | StreamCallback,
    encodingOrCallback?: string | StreamCallback,
    callback?: StreamCallback
  ): Transform {
    const chunk = typeof chunkOrCallback === "function" ? undefined : chunkOrCallback;
    const done = typeof chunkOrCallback === "function"
      ? chunkOrCallback
      : typeof encodingOrCallback === "function"
        ? encodingOrCallback
        : callback;
    if (chunk !== undefined) this.write(chunk);
    const flush = this._flush ?? this.__browserTransformOptions?.flush;
    const finish = (error?: Error | null, data?: RuntimeValue) => {
      if (error) {
        this.destroy(error);
        done?.(error);
        return;
      }
      if (data !== undefined) this.push(data);
      this.writable = false;
      this.push(null);
      this.emit("finish");
      done?.();
    };
    if (flush) flush.call(this, finish);
    else finish();
    return this;
  };
  LegacyTransform.prototype.setEncoding = function setEncoding(this: Transform & LegacyTransformState, encoding: BufferEncoding): Transform {
    readableEncoding.set(this, encoding);
    this._readableState.encoding = encoding;
    return this;
  };
  LegacyTransform.prototype.destroy = function destroy(this: Transform & LegacyTransformState, error?: RuntimeValue): Transform {
    this.readable = false;
    this.writable = false;
    if (error) this.emit("error", error);
    this.emit("close");
    return this;
  };

  function scheduleLegacyReadableFlush(stream: Transform & LegacyTransformState): void {
    queueMicrotask(() => {
      const queue = stream.__browserReadableQueue;
      while (queue.length > 0 && stream.listenerCount("data") > 0) stream.emit("data", queue.shift());
      if (stream.__browserReadableEnded && !stream.__browserReadableEndEmitted && stream.listenerCount("end") > 0) {
        stream.__browserReadableEndEmitted = true;
        stream.emit("end");
        stream.emit("close");
      }
    });
  }
  return LegacyTransform;
}

interface LegacyTransformState {
  __browserReadableEnded: boolean;
  __browserReadableEndEmitted: boolean;
  __browserReadableQueue: RuntimeValue[];
  __browserTransformOptions?: TransformOptions;
  _flush?: (callback: TransformCallback) => void;
  _readableState: { encoding: BufferEncoding | null; objectMode: boolean };
  _transform?: (chunk: RuntimeValue, encoding: string, callback: TransformCallback) => void;
  _writableState: { objectMode: boolean };
  readable: boolean;
  writable: boolean;
}
