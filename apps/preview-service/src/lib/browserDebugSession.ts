import { DapClient } from "./dapClient.ts";
import type { DapTransport } from "./dapProtocol.ts";
import { HostProcessDapTransport } from "./hostProcessDapTransport.ts";

export type DebugSessionState = "stopped" | "starting" | "paused" | "running" | "terminated" | "failed";

export interface DebugSnapshot {
  state: DebugSessionState;
  reason: string | null;
  line: number | null;
  stack: string[];
  scopes: string[];
  variables: Array<{ name: string; value: string; type?: string }>;
  watches: Array<{ expression: string; value: string }>;
  console: string[];
}

const EMPTY_SNAPSHOT: DebugSnapshot = {
  state: "stopped",
  reason: null,
  line: null,
  stack: [],
  scopes: [],
  variables: [],
  watches: [],
  console: []
};

export class BrowserDebugSession {
  readonly #createTransport: () => Promise<DapTransport>;
  #client: DapClient | null = null;
  #snapshot: DebugSnapshot = EMPTY_SNAPSHOT;
  #listener: (snapshot: DebugSnapshot) => void = () => undefined;
  #terminatedResolver: (() => void) | null = null;

  constructor(createTransport = () => HostProcessDapTransport.start()) {
    this.#createTransport = createTransport;
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

  async start(options: { breakpointLine?: number; condition?: string } = {}): Promise<void> {
    await this.dispose();
    this.#publish({ ...EMPTY_SNAPSHOT, state: "starting" });
    const client = new DapClient(await this.#createTransport());
    this.#client = client;
    client.onEvent((event) => {
      if (event.event === "stopped") {
        const reason = (event.body as { reason?: string } | undefined)?.reason || "paused";
        void this.#refreshPaused(reason);
      }
      if (event.event === "terminated") {
        this.#publish({ ...this.#snapshot, state: "terminated" });
        this.#terminatedResolver?.();
        this.#terminatedResolver = null;
      }
    });
    try {
      await client.request("initialize", { clientID: "cargo-container", adapterID: "cargo-fixture" });
      await client.request("launch", { program: "file:///workspace/debug-fixture.ts", noDebug: false });
      await client.request("setBreakpoints", {
        source: { path: "file:///workspace/debug-fixture.ts" },
        breakpoints: [{ line: options.breakpointLine || 3, ...(options.condition ? { condition: options.condition } : {}) }]
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
    const client = this.#client;
    if (!client) return;
    const terminated = new Promise<void>((resolve) => {
      this.#terminatedResolver = resolve;
    });
    await this.#request("terminate", { restart: false });
    await Promise.race([
      terminated,
      new Promise<void>((_, reject) => setTimeout(() => reject(new Error("DAP terminated event timed out.")), 1_000))
    ]);
    if (this.#client === client) {
      this.#client = null;
      client.dispose();
    }
  }

  async evaluateWatch(expression: string): Promise<void> {
    const response = await this.#request<{ result: string }>("evaluate", { expression, context: "watch", frameId: 100 });
    const watches = [...this.#snapshot.watches.filter((entry) => entry.expression !== expression), { expression, value: response.result }];
    this.#publish({ ...this.#snapshot, watches });
  }

  async evaluateConsole(expression: string): Promise<void> {
    const response = await this.#request<{ result: string }>("evaluate", { expression, context: "repl", frameId: 100 });
    this.#publish({ ...this.#snapshot, console: [...this.#snapshot.console, `> ${expression}`, response.result] });
    if (/^counter\s*=/.test(expression)) await this.#refreshPaused(this.#snapshot.reason || "paused");
  }

  async dispose(): Promise<void> {
    const client = this.#client;
    this.#client = null;
    this.#terminatedResolver?.();
    this.#terminatedResolver = null;
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
      variables: variables.variables,
      watches: this.#snapshot.watches,
      console: this.#snapshot.console
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
