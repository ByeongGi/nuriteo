import { EventEmitter } from "./events.ts";

export class UnsupportedWorkerThreadError extends Error {
  code = "ERR_BROWSER_WORKER_THREAD_UNSUPPORTED";

  constructor(filename: string | URL) {
    super(`Node worker_threads execution is not available in the browser runtime: ${String(filename)}`);
    this.name = "UnsupportedWorkerThreadError";
  }
}

export interface WorkerOptions {
  argv?: readonly string[];
  env?: Record<string, string | undefined> | typeof SHARE_ENV;
  eval?: boolean;
  execArgv?: readonly string[];
  name?: string;
  stdin?: boolean;
  stdout?: boolean;
  stderr?: boolean;
  transferList?: readonly Transferable[];
  workerData?: unknown;
}

export type MessageListener = (value: unknown) => void;

export class MessagePort extends EventEmitter {
  #closed = false;
  #peer: MessagePort | null = null;

  postMessage(value: unknown): void {
    if (this.#closed || !this.#peer || this.#peer.#closed) return;
    const peer = this.#peer;
    queueMicrotask(() => peer.emit("message", value));
  }

  start(): void {}

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.emit("close");
  }

  ref(): this {
    return this;
  }

  unref(): this {
    return this;
  }

  addMessageListener(listener: MessageListener): this {
    this.on("message", listener);
    return this;
  }

  removeMessageListener(listener: MessageListener): this {
    this.off("message", listener);
    return this;
  }

  link(peer: MessagePort): void {
    this.#peer = peer;
  }
}

export class MessageChannel {
  port1 = new MessagePort();
  port2 = new MessagePort();

  constructor() {
    this.port1.link(this.port2);
    this.port2.link(this.port1);
  }
}

export class Worker extends EventEmitter {
  readonly stdin = null;
  readonly stdout = null;
  readonly stderr = null;
  readonly threadId = 0;
  readonly resourceLimits = Object.freeze({});
  readonly workerData: unknown;
  #terminated = false;

  constructor(filename: string | URL, options: WorkerOptions = {}) {
    super();
    this.workerData = options.workerData;
    queueMicrotask(() => {
      if (this.#terminated) return;
      this.emit("error", new UnsupportedWorkerThreadError(filename));
      this.emit("exit", 1);
    });
  }

  postMessage(_value: unknown): void {}

  terminate(): Promise<number> {
    if (this.#terminated) return Promise.resolve(0);
    this.#terminated = true;
    this.emit("exit", 0);
    return Promise.resolve(0);
  }

  ref(): this {
    return this;
  }

  unref(): this {
    return this;
  }
}

export function markAsUntransferable(_object: object): void {}

export function moveMessagePortToContext(port: MessagePort): MessagePort {
  return port;
}

export function receiveMessageOnPort(_port: MessagePort): undefined {
  return undefined;
}

export const SHARE_ENV = Symbol.for("nodejs.worker_threads.SHARE_ENV");
export const isMainThread = true;
export const parentPort = null;
export const threadId = 0;
export const workerData = null;

export const workerThreadsBuiltin = Object.freeze({
  MessageChannel,
  MessagePort,
  SHARE_ENV,
  Worker,
  isMainThread,
  markAsUntransferable,
  moveMessagePortToContext,
  parentPort,
  receiveMessageOnPort,
  threadId,
  workerData
});
