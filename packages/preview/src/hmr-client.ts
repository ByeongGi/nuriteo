import type { HmrClientError, HmrClientOptions, HmrClientSnapshot, HmrClientState, HmrEventType, HmrListener, HmrSocket } from "./types.ts";

export class HmrClient {
  connect: () => HmrSocket;
  maxRetries: number;
  reconnectDelayMs: number;
  listeners: Map<HmrEventType, Set<HmrListener>>;
  socket: HmrSocket | null;
  retryCount: number;
  closed: boolean;
  state: HmrClientState;
  lastError: HmrClientError | null;

  constructor(options: HmrClientOptions = {}) {
    this.connect = options.connect || (() => createMemorySocket());
    this.maxRetries = options.maxRetries ?? 3;
    this.reconnectDelayMs = options.reconnectDelayMs ?? 0;
    this.listeners = new Map();
    this.socket = null;
    this.retryCount = 0;
    this.closed = false;
    this.state = "idle";
    this.lastError = null;
  }

  start(): HmrClient {
    this.closed = false;
    this.#open();
    return this;
  }

  on(type: HmrEventType, listener: HmrListener): () => boolean {
    const listeners = this.listeners.get(type) || new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
    return () => listeners.delete(listener);
  }

  close(): void {
    this.closed = true;
    this.state = "closed";
    this.socket?.close?.();
  }

  snapshot(): HmrClientSnapshot {
    return {
      state: this.state,
      retryCount: this.retryCount,
      maxRetries: this.maxRetries,
      lastError: this.lastError
    };
  }

  #open(): void {
    this.socket = this.connect();
    this.state = "connected";
    this.lastError = null;
    this.socket.onmessage = (event) => {
      try {
        this.#emit("message", JSON.parse(event.data));
      } catch (error) {
        const hmrError = {
          code: "EBADMESSAGE",
          message: error instanceof Error ? error.message : "invalid HMR message"
        } satisfies HmrClientError;
        this.state = "error";
        this.lastError = hmrError;
        this.#emit("error", hmrError);
      }
    };
    this.socket.onclose = () => {
      this.#emit("close", {});
      if (!this.closed && this.retryCount < this.maxRetries) {
        this.retryCount += 1;
        this.state = "reconnecting";
        this.#emit("reconnect", { attempt: this.retryCount + 1, delayMs: this.reconnectDelayMs });
        setTimeout(() => this.#open(), this.reconnectDelayMs);
      } else if (!this.closed) {
        this.state = "closed";
      }
    };
    this.#emit("open", { attempt: this.retryCount + 1 });
  }

  #emit(type: HmrEventType, payload: unknown): void {
    for (const listener of this.listeners.get(type) || []) listener(payload);
  }
}

export function createHmrClient(options: HmrClientOptions = {}): HmrClient {
  return new HmrClient(options);
}

function createMemorySocket(): HmrSocket {
  return {
    close() {
      this.onclose?.();
    },
    sendMessage(payload) {
      this.onmessage?.({ data: JSON.stringify(payload) });
    }
  };
}
