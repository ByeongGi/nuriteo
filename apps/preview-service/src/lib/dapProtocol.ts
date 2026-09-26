export interface DapRequest {
  seq: number;
  type: "request";
  command: string;
  arguments?: unknown;
}

export interface DapResponse {
  seq: number;
  type: "response";
  request_seq: number;
  success: boolean;
  command: string;
  message?: string;
  body?: unknown;
}

export interface DapEvent {
  seq: number;
  type: "event";
  event: string;
  body?: unknown;
}

export type DapMessage = DapRequest | DapResponse | DapEvent;

export interface DapTransport {
  send(message: DapRequest): void;
  subscribe(listener: (message: DapResponse | DapEvent) => void): () => void;
  dispose(): void;
}

export class WorkerDapTransport implements DapTransport {
  readonly #worker: Worker;
  readonly #listeners = new Set<(message: DapResponse | DapEvent) => void>();
  readonly #onMessage: (event: MessageEvent<DapResponse | DapEvent>) => void;

  constructor(worker: Worker) {
    this.#worker = worker;
    this.#onMessage = (event) => {
      for (const listener of this.#listeners) listener(event.data);
    };
    worker.addEventListener("message", this.#onMessage);
  }

  send(message: DapRequest): void {
    this.#worker.postMessage(message);
  }

  subscribe(listener: (message: DapResponse | DapEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  dispose(): void {
    this.#worker.removeEventListener("message", this.#onMessage);
    this.#listeners.clear();
    this.#worker.terminate();
  }
}
