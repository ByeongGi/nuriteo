export class HmrClient {
  constructor(options = {}) {
    this.connect = options.connect || (() => createMemorySocket());
    this.maxRetries = options.maxRetries ?? 3;
    this.reconnectDelayMs = options.reconnectDelayMs ?? 0;
    this.listeners = new Map();
    this.socket = null;
    this.retryCount = 0;
    this.closed = false;
  }

  start() {
    this.closed = false;
    this.#open();
    return this;
  }

  on(type, listener) {
    const listeners = this.listeners.get(type) || new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
    return () => listeners.delete(listener);
  }

  close() {
    this.closed = true;
    this.socket?.close?.();
  }

  #open() {
    this.socket = this.connect();
    this.socket.onmessage = (event) => this.#emit("message", JSON.parse(event.data));
    this.socket.onclose = () => {
      this.#emit("close", {});
      if (!this.closed && this.retryCount < this.maxRetries) {
        this.retryCount += 1;
        setTimeout(() => this.#open(), this.reconnectDelayMs);
      }
    };
    this.#emit("open", { attempt: this.retryCount + 1 });
  }

  #emit(type, payload) {
    for (const listener of this.listeners.get(type) || []) listener(payload);
  }
}

export function createHmrClient(options) {
  return new HmrClient(options);
}

function createMemorySocket() {
  return {
    close() {
      this.onclose?.();
    },
    sendMessage(payload) {
      this.onmessage?.({ data: JSON.stringify(payload) });
    }
  };
}

