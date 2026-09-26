import type { DapEvent, DapRequest, DapResponse, DapTransport } from "./dapProtocol.ts";

const DAP_TIMEOUT_MS = 5_000;

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

export class DapClient {
  readonly #transport: DapTransport;
  readonly #pending = new Map<number, Pending>();
  readonly #eventListeners = new Set<(event: DapEvent) => void>();
  readonly #unsubscribe: () => void;
  #sequence = 1;

  constructor(transport: DapTransport) {
    this.#transport = transport;
    this.#unsubscribe = transport.subscribe((message) => this.#receive(message));
  }

  request<T>(command: string, args?: unknown): Promise<T> {
    const seq = this.#sequence++;
    const request: DapRequest = { seq, type: "request", command, ...(args === undefined ? {} : { arguments: args }) };
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(seq);
        reject(new Error(`DAP request timed out: ${command}`));
      }, DAP_TIMEOUT_MS);
      this.#pending.set(seq, { resolve: (value) => resolve(value as T), reject, timeout });
      this.#transport.send(request);
    });
  }

  onEvent(listener: (event: DapEvent) => void): () => void {
    this.#eventListeners.add(listener);
    return () => this.#eventListeners.delete(listener);
  }

  dispose(): void {
    this.#unsubscribe();
    this.#transport.dispose();
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("DAP client disposed."));
    }
    this.#pending.clear();
    this.#eventListeners.clear();
  }

  #receive(message: DapResponse | DapEvent): void {
    if (message.type === "event") {
      for (const listener of this.#eventListeners) listener(message);
      return;
    }
    const pending = this.#pending.get(message.request_seq);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.#pending.delete(message.request_seq);
    if (!message.success) pending.reject(new Error(message.message || `DAP ${message.command} failed.`));
    else pending.resolve(message.body);
  }
}
