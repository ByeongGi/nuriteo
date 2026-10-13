export interface SqliteWorkerMessage {
  id: string;
  projectId: string;
  database: string;
  action: "replace-values" | "read-values";
  values?: string[];
}

export interface SqliteWorkerResponse {
  id: string;
  ok: boolean;
  rows?: string[];
  sqliteVersion?: string;
  databasePath?: string;
  error?: string;
}

export interface SqliteWorkerLike {
  postMessage(message: SqliteWorkerMessage): void;
  addEventListener(type: "message", listener: (event: { data: SqliteWorkerResponse }) => void): void;
  addEventListener(type: "error", listener: (event: { message?: string }) => void, options?: { once?: boolean }): void;
  removeEventListener?(type: "message" | "error", listener: (...args: any[]) => void): void;
  terminate(): void;
}

export interface SqliteProjectClientOptions {
  projectId: string;
  database?: string;
  createWorker(): SqliteWorkerLike;
  timeoutMs?: number;
}

export class SqliteProjectClient {
  readonly projectId: string;
  readonly database: string;
  #worker: SqliteWorkerLike;
  #timeoutMs: number;
  #closed = false;

  constructor(options: SqliteProjectClientOptions) {
    this.projectId = safeName(options.projectId, "projectId");
    this.database = safeName(options.database ?? "project", "database");
    this.#worker = options.createWorker();
    this.#timeoutMs = options.timeoutMs ?? 10_000;
  }

  replaceValues(values: string[]): Promise<SqliteWorkerResponse> {
    return this.#request({ action: "replace-values", values: [...values] });
  }

  readValues(): Promise<SqliteWorkerResponse> {
    return this.#request({ action: "read-values" });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#worker.terminate();
  }

  #request(input: Pick<SqliteWorkerMessage, "action" | "values">): Promise<SqliteWorkerResponse> {
    if (this.#closed) return Promise.reject(Object.assign(new Error("SQLite project client is closed"), { code: "ESQLITECLOSED" }));
    const id = globalThis.crypto?.randomUUID?.() ?? `sqlite-${Date.now()}-${Math.random()}`;
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timeout);
        this.#worker.removeEventListener?.("message", onMessage as (...args: any[]) => void);
        this.#worker.removeEventListener?.("error", onError as (...args: any[]) => void);
      };
      const onMessage = (event: { data: SqliteWorkerResponse }) => {
        if (event.data?.id !== id) return;
        cleanup();
        if (!event.data.ok) reject(Object.assign(new Error(event.data.error || "SQLite worker request failed"), { code: "ESQLITEWORKER" }));
        else resolve(event.data);
      };
      const onError = (event: { message?: string }) => {
        cleanup();
        reject(Object.assign(new Error(event.message || "SQLite worker crashed"), { code: "ESQLITEWORKER" }));
      };
      const timeout = setTimeout(() => {
        cleanup();
        reject(Object.assign(new Error(`SQLite worker request timed out after ${this.#timeoutMs}ms`), { code: "ESQLITETIMEOUT" }));
      }, this.#timeoutMs);
      this.#worker.addEventListener("message", onMessage);
      this.#worker.addEventListener("error", onError, { once: true });
      this.#worker.postMessage({
        id,
        projectId: this.projectId,
        database: this.database,
        ...input
      });
    });
  }
}

export function createSqliteProjectClient(options: SqliteProjectClientOptions): SqliteProjectClient {
  return new SqliteProjectClient(options);
}

function safeName(value: string, field: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value)) {
    throw Object.assign(new Error(`Invalid SQLite ${field}: ${value}`), { code: "ESQLITEPROJECT" });
  }
  return value;
}
