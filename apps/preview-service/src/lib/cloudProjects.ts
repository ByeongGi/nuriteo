export interface CloudProject {
  id: string;
  name: string;
  updatedAt: string;
  generation: number;
}

export interface CloudSnapshot {
  projectId: string;
  generation: number;
  files: Array<{ path: string; content: string }>;
}

export class CloudProjectsClient {
  #baseUrl: string;
  #token: () => string;

  constructor(options: { baseUrl?: string; token: () => string }) {
    this.#baseUrl = (options.baseUrl ?? "").replace(/\/$/, "");
    this.#token = options.token;
  }

  list(): Promise<CloudProject[]> { return this.#request("GET", "/api/projects"); }
  create(name: string): Promise<CloudProject> { return this.#request("POST", "/api/projects", { name }); }
  save(projectId: string, files: CloudSnapshot["files"]): Promise<CloudSnapshot> {
    return this.#request("PUT", `/api/projects/${encodeURIComponent(projectId)}/snapshot`, { files });
  }
  async resume(projectId: string): Promise<{ project: CloudProject; snapshot: CloudSnapshot }> {
    return this.#request("GET", `/api/projects/${encodeURIComponent(projectId)}/resume`);
  }
  createShare(projectId: string, accessMode: "read_only" | "forkable"): Promise<{ token: string }> {
    return this.#request("POST", `/api/projects/${encodeURIComponent(projectId)}/shares`, { accessMode });
  }
  fork(token: string, name?: string): Promise<CloudProject> {
    return this.#request("POST", "/api/shares/fork", { token, name });
  }
  ingestUsage(event: { id: string; kind: "storage_bytes" | "install" | "runtime_minutes"; quantity: number; occurredAt: string }): Promise<{ inserted: boolean }> {
    return this.#request("POST", "/api/usage", event);
  }

  async #request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const token = this.#token();
    const response = await fetch(`${this.#baseUrl}${path}`, {
      method,
      headers: {
        Accept: "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : { "Content-Type": "application/json" })
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    const payload = await response.json() as T & { message?: string };
    if (!response.ok) throw new Error(payload.message || `Cloud project request failed (${response.status})`);
    return payload;
  }
}
