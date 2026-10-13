import { EventEmitter } from "./events.ts";

export interface ReadlineInterfaceOptions {
  input?: AsyncIterable<Uint8Array | string> | Iterable<Uint8Array | string>;
  output?: unknown;
  terminal?: boolean;
  crlfDelay?: number;
}

export class Interface extends EventEmitter {
  private closed = false;
  private input?: ReadlineInterfaceOptions["input"];

  constructor(options: ReadlineInterfaceOptions = {}) {
    super();
    this.input = options.input;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.emit("close");
  }

  pause(): this {
    return this;
  }

  prompt(): void {
    this.emit("prompt");
  }

  resume(): this {
    return this;
  }

  question(query: string, callback: (answer: string) => void): void {
    this.emit("prompt", query);
    queueMicrotask(() => callback(""));
  }

  async *[Symbol.asyncIterator](): AsyncIterableIterator<string> {
    if (!this.input) return;
    let pending = "";
    const decoder = new TextDecoder();
    for await (const chunk of toAsyncIterable(this.input)) {
      pending += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() || "";
      for (const line of lines) yield line;
    }
    pending += decoder.decode();
    if (pending) yield pending;
  }
}

export function createInterface(options: ReadlineInterfaceOptions = {}): Interface {
  return new Interface(options);
}

export function emitKeypressEvents(_stream: unknown, _interface?: Interface): void {}

export const readlineBuiltin = Object.freeze({
  Interface,
  createInterface,
  emitKeypressEvents
});

async function* toAsyncIterable<T>(input: AsyncIterable<T> | Iterable<T>): AsyncIterable<T> {
  if (Symbol.asyncIterator in input) {
    yield* input;
    return;
  }
  yield* input;
}
