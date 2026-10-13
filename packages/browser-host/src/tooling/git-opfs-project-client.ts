export type GitOpfsAction = "init" | "status" | "write-file" | "read-file" | "add" | "commit" | "log";

export interface GitOpfsWorkerMessage {
  id: string;
  projectId: string;
  action: GitOpfsAction;
  path?: string;
  contents?: string;
  message?: string;
  author?: { name: string; email: string };
  maxEntries?: number;
}

export interface GitOpfsWorkerResponse {
  id: string;
  ok: boolean;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  contents?: string;
  variant?: string;
  artifactSha256?: string;
  error?: string;
  code?: string;
}

export interface GitOpfsWorkerLike {
  postMessage(message: GitOpfsWorkerMessage): void;
  addEventListener(type: "message", listener: (event: { data: GitOpfsWorkerResponse }) => void): void;
  addEventListener(type: "error", listener: (event: { message?: string }) => void, options?: { once?: boolean }): void;
  removeEventListener?(type: "message" | "error", listener: (...args: any[]) => void): void;
  terminate(): void;
}

export interface GitOpfsProjectClientOptions {
  projectId: string;
  createWorker(): GitOpfsWorkerLike;
  timeoutMs?: number;
  maxFileBytes?: number;
}

export class GitOpfsProjectClient {
  readonly projectId: string;
  readonly maxFileBytes: number;
  #worker: GitOpfsWorkerLike;
  #timeoutMs: number;
  #closed = false;

  constructor(options: GitOpfsProjectClientOptions) {
    this.projectId = safeProjectId(options.projectId);
    this.maxFileBytes = positiveLimit(options.maxFileBytes ?? 16 * 1024 * 1024, "maxFileBytes");
    this.#timeoutMs = positiveLimit(options.timeoutMs ?? 10_000, "timeoutMs");
    this.#worker = options.createWorker();
  }

  init(): Promise<GitOpfsWorkerResponse> {
    return this.#request({ action: "init" });
  }

  status(): Promise<GitOpfsWorkerResponse> {
    return this.#request({ action: "status" });
  }

  writeFile(path: string, contents: string): Promise<GitOpfsWorkerResponse> {
    const safePath = projectPath(path);
    if (byteLength(contents) > this.maxFileBytes) throw clientError("EGITFILELIMIT", `Git project file exceeds ${this.maxFileBytes} bytes`);
    return this.#request({ action: "write-file", path: safePath, contents });
  }

  readFile(path: string): Promise<GitOpfsWorkerResponse> {
    return this.#request({ action: "read-file", path: projectPath(path) });
  }

  add(path: string): Promise<GitOpfsWorkerResponse> {
    return this.#request({ action: "add", path: projectPath(path) });
  }

  commit(message: string, author: { name: string; email: string }): Promise<GitOpfsWorkerResponse> {
    const normalizedMessage = message.trim();
    const name = author.name.trim();
    const email = author.email.trim();
    if (!normalizedMessage || byteLength(normalizedMessage) > 64 * 1024) throw clientError("EGITCOMMIT", "Invalid Git commit message");
    if (!name || !email || /[\r\n]/.test(`${name}${email}`)) throw clientError("EGITAUTHOR", "Invalid Git author");
    return this.#request({ action: "commit", message: normalizedMessage, author: { name, email } });
  }

  log(maxEntries = 20): Promise<GitOpfsWorkerResponse> {
    if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0 || maxEntries > 1000) throw clientError("EGITLOG", "Invalid Git log limit");
    return this.#request({ action: "log", maxEntries });
  }

  fetch(_remote: string): never {
    throw clientError("EGITNETWORK", "Git fetch requires a separately approved host-mediated transport");
  }

  clone(_remote: string): never {
    throw clientError("EGITNETWORK", "Git clone requires a separately approved host-mediated transport");
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#worker.terminate();
  }

  #request(input: Omit<GitOpfsWorkerMessage, "id" | "projectId">): Promise<GitOpfsWorkerResponse> {
    if (this.#closed) return Promise.reject(clientError("EGITCLOSED", "Git OPFS project client is closed"));
    const id = globalThis.crypto?.randomUUID?.() ?? `git-${Date.now()}-${Math.random()}`;
    return new Promise((resolve, reject) => {
      const cleanup = (): void => {
        clearTimeout(timeout);
        this.#worker.removeEventListener?.("message", onMessage as (...args: any[]) => void);
        this.#worker.removeEventListener?.("error", onError as (...args: any[]) => void);
      };
      const onMessage = (event: { data: GitOpfsWorkerResponse }): void => {
        if (event.data?.id !== id) return;
        cleanup();
        if (!event.data.ok) reject(clientError(event.data.code || "EGITWORKER", event.data.error || "Git OPFS worker request failed"));
        else resolve(event.data);
      };
      const onError = (event: { message?: string }): void => {
        cleanup();
        reject(clientError("EGITWORKER", event.message || "Git OPFS worker crashed"));
      };
      const timeout = setTimeout(() => {
        cleanup();
        reject(clientError("EGITTIMEOUT", `Git OPFS worker request timed out after ${this.#timeoutMs}ms`));
      }, this.#timeoutMs);
      this.#worker.addEventListener("message", onMessage);
      this.#worker.addEventListener("error", onError, { once: true });
      this.#worker.postMessage({ id, projectId: this.projectId, ...input });
    });
  }
}

export function createGitOpfsProjectClient(options: GitOpfsProjectClientOptions): GitOpfsProjectClient {
  return new GitOpfsProjectClient(options);
}

function safeProjectId(value: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value)) throw clientError("EGITPROJECT", "Invalid Git project ID");
  return value;
}

function projectPath(value: string): string {
  if (!value || value.startsWith("/") || value.includes("\0")) throw clientError("EGITPROJECTPATH", "Invalid Git project path");
  const parts: string[] = [];
  for (const part of value.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) throw clientError("EGITPROJECTPATH", "Git path escapes the project");
      parts.pop();
    } else parts.push(part);
  }
  const normalized = parts.join("/");
  if (!normalized) throw clientError("EGITPROJECTPATH", "Git project path is empty");
  const comparable = normalized.toLowerCase();
  if (comparable === ".git" || comparable.startsWith(".git/")) throw clientError("EGITMETADATA", "Direct Git metadata access is disabled");
  return normalized;
}

function positiveLimit(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw clientError("EGITLIMIT", `Invalid Git ${field}`);
  return value;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function clientError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}
