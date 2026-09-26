import { DapClient } from "./dapClient.ts";
import { WorkerDapTransport } from "./dapProtocol.ts";

export type DebugSessionState = "stopped" | "starting" | "paused" | "running" | "terminated" | "failed";

export interface DebugSnapshot {
  state: DebugSessionState;
  reason: string | null;
  line: number | null;
  stack: string[];
  scopes: string[];
  variables: Array<{ name: string; value: string; type?: string }>;
}

const EMPTY_SNAPSHOT: DebugSnapshot = { state: "stopped", reason: null, line: null, stack: [], scopes: [], variables: [] };

export class BrowserDebugSession {
  readonly #createWorker: () => Worker;
  #client: DapClient | null = null;
  #snapshot: DebugSnapshot = EMPTY_SNAPSHOT;
  #listener: (snapshot: DebugSnapshot) => void = () => undefined;

  constructor(createWorker = () => new Worker(new URL("../workers/debugAdapter.worker.ts", import.meta.url), {
    type: "module",
    name: "cargo-debug-adapter"
  })) {
    this.#createWorker = createWorker;
  }

  get snapshot(): DebugSnapshot {
    return this.#snapshot;
  }

  subscribe(listener: (snapshot: DebugSnapshot) => void): () => void {
    this.#listener = listener;
    listener(this.#snapshot);
    return () => {
      this.#listener = () => undefined;
    };
  }

  async start(): Promise<void> {
    await this.dispose();
    this.#publish({ ...EMPTY_SNAPSHOT, state: "starting" });
    const client = new DapClient(new WorkerDapTransport(this.#createWorker()));
    this.#client = client;
    client.onEvent((event) => {
      if (event.event === "stopped") {
        const reason = (event.body as { reason?: string } | undefined)?.reason || "paused";
        void this.#refreshPaused(reason);
      }
      if (event.event === "terminated") this.#publish({ ...this.#snapshot, state: "terminated" });
    });
    try {
      await client.request("initialize", { clientID: "cargo-container", adapterID: "cargo-fixture" });
      await client.request("launch", { program: "file:///workspace/debug-fixture.ts", noDebug: false });
      await client.request("setBreakpoints", {
        source: { path: "file:///workspace/debug-fixture.ts" },
        breakpoints: [{ line: 3 }]
      });
      await client.request("configurationDone");
    } catch (error) {
      this.#publish({ ...this.#snapshot, state: "failed", reason: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  async continue(): Promise<void> {
    this.#publish({ ...this.#snapshot, state: "running", reason: null });
    await this.#request("continue", { threadId: 1 });
  }

  async step(command: "next" | "stepIn" | "stepOut"): Promise<void> {
    this.#publish({ ...this.#snapshot, state: "running", reason: null });
    await this.#request(command, { threadId: 1 });
  }

  async terminate(): Promise<void> {
    if (!this.#client) return;
    await this.#request("terminate", { restart: false });
  }

  async dispose(): Promise<void> {
    const client = this.#client;
    this.#client = null;
    client?.dispose();
    this.#snapshot = EMPTY_SNAPSHOT;
  }

  async #refreshPaused(reason: string): Promise<void> {
    const client = this.#client;
    if (!client) return;
    const stack = await client.request<{ stackFrames: Array<{ id: number; name: string; line: number }> }>("stackTrace", { threadId: 1 });
    const frame = stack.stackFrames[0];
    if (!frame) return;
    const scopes = await client.request<{ scopes: Array<{ name: string; variablesReference: number }> }>("scopes", { frameId: frame.id });
    const scope = scopes.scopes[0];
    const variables = scope
      ? await client.request<{ variables: Array<{ name: string; value: string; type?: string }> }>("variables", { variablesReference: scope.variablesReference })
      : { variables: [] };
    this.#publish({
      state: "paused",
      reason,
      line: frame.line,
      stack: stack.stackFrames.map((entry) => `${entry.name}:${entry.line}`),
      scopes: scopes.scopes.map((entry) => entry.name),
      variables: variables.variables
    });
  }

  #request<T>(command: string, args?: unknown): Promise<T> {
    if (!this.#client) return Promise.reject(new Error("Debug session is not active."));
    return this.#client.request<T>(command, args);
  }

  #publish(snapshot: DebugSnapshot): void {
    this.#snapshot = snapshot;
    this.#listener(snapshot);
  }
}
