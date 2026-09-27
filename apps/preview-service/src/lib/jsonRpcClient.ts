import {
  isJsonRpcNotification,
  isJsonRpcResponse,
  type JsonRpcMessage,
  type JsonRpcNotification
} from "./lspProtocol.ts";

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

export interface JsonRpcTransport {
  send(message: JsonRpcMessage): void;
  subscribe(listener: (message: JsonRpcMessage) => void): () => void;
  dispose(): void;
}

type PendingRequest = {
  cleanupAbort: () => void;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

export class JsonRpcClient {
  readonly #transport: JsonRpcTransport;
  readonly #pending = new Map<number, PendingRequest>();
  readonly #notificationListeners = new Set<(message: JsonRpcNotification) => void>();
  readonly #unsubscribe: () => void;
  #nextId = 1;
  #disposed = false;

  constructor(transport: JsonRpcTransport) {
    this.#transport = transport;
    this.#unsubscribe = transport.subscribe((message) => this.#receive(message));
  }

  request<T>(method: string, params?: unknown, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS, signal?: AbortSignal): Promise<T> {
    if (this.#disposed) return Promise.reject(new Error("JSON-RPC client is disposed."));
    if (signal?.aborted) return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error("JSON-RPC request aborted."));
    const id = this.#nextId++;
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(id);
        cleanupAbort();
        reject(new Error(`JSON-RPC request timed out: ${method}`));
      }, timeoutMs);
      const abort = () => {
        const pending = this.#pending.get(id);
        if (!pending) return;
        clearTimeout(pending.timeout);
        this.#pending.delete(id);
        pending.cleanupAbort();
        this.notify("$/cancelRequest", { id });
        reject(signal?.reason instanceof Error ? signal.reason : new Error(`JSON-RPC request aborted: ${method}`));
      };
      const cleanupAbort = () => signal?.removeEventListener("abort", abort);
      signal?.addEventListener("abort", abort, { once: true });
      this.#pending.set(id, {
        cleanupAbort,
        resolve: (value) => resolve(value as T),
        reject,
        timeout
      });
      this.#transport.send({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.#disposed) return;
    this.#transport.send({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) });
  }

  onNotification(listener: (message: JsonRpcNotification) => void): () => void {
    this.#notificationListeners.add(listener);
    return () => this.#notificationListeners.delete(listener);
  }

  dispose(reason = "JSON-RPC client disposed."): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#unsubscribe();
    this.#transport.dispose();
    for (const request of this.#pending.values()) {
      clearTimeout(request.timeout);
      request.cleanupAbort();
      request.reject(new Error(reason));
    }
    this.#pending.clear();
    this.#notificationListeners.clear();
  }

  #receive(message: JsonRpcMessage): void {
    if (isJsonRpcResponse(message)) {
      const pending = typeof message.id === "number" ? this.#pending.get(message.id) : undefined;
      if (!pending) return;
      clearTimeout(pending.timeout);
      pending.cleanupAbort();
      this.#pending.delete(message.id as number);
      if (message.error) pending.reject(new Error(`${message.error.code}: ${message.error.message}`));
      else pending.resolve(message.result);
      return;
    }
    if (isJsonRpcNotification(message)) {
      for (const listener of this.#notificationListeners) listener(message);
    }
  }
}

export class WorkerJsonRpcTransport implements JsonRpcTransport {
  readonly #worker: Worker;
  readonly #listeners = new Set<(message: JsonRpcMessage) => void>();
  readonly #onMessage: (event: MessageEvent<JsonRpcMessage>) => void;

  constructor(worker: Worker) {
    this.#worker = worker;
    this.#onMessage = (event) => {
      for (const listener of this.#listeners) listener(event.data);
    };
    worker.addEventListener("message", this.#onMessage);
  }

  send(message: JsonRpcMessage): void {
    this.#worker.postMessage(message);
  }

  subscribe(listener: (message: JsonRpcMessage) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  dispose(): void {
    this.#worker.removeEventListener("message", this.#onMessage);
    this.#listeners.clear();
    this.#worker.terminate();
  }
}
