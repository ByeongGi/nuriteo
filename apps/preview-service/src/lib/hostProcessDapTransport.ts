import { HostProcessTable } from "../../../../packages/browser-host/src/process/spawn.ts";
import { createPermissionManager } from "../../../../packages/browser-host/src/security/permissions.ts";
import type { DapEvent, DapRequest, DapResponse, DapTransport } from "./dapProtocol.ts";

type RuntimeWorkerMessage =
  | { type: "dap"; message: DapResponse | DapEvent }
  | { type: "ready" }
  | { type: "exit"; code: number };

export class HostProcessDapTransport implements DapTransport {
  readonly #table: HostProcessTable;
  readonly #pid: number;
  readonly #worker: Worker;
  readonly #listeners = new Set<(message: DapResponse | DapEvent) => void>();
  readonly #onMessage: (event: MessageEvent<RuntimeWorkerMessage>) => void;

  private constructor(table: HostProcessTable, pid: number, worker: Worker) {
    this.#table = table;
    this.#pid = pid;
    this.#worker = worker;
    this.#onMessage = (event) => {
      if (event.data.type !== "dap") return;
      for (const listener of this.#listeners) listener(event.data.message);
    };
    worker.addEventListener("message", this.#onMessage);
  }

  static async start(): Promise<HostProcessDapTransport> {
    const resource = "worker://cargo/debug-runtime";
    const permissions = createPermissionManager({
      defaultDecision: "deny",
      rules: [{ scope: "process", action: "prepare", resourcePrefix: resource, decision: "allow" }]
    });
    const table = new HostProcessTable({
      permissions,
      workerFactory: () => new Worker(
        new URL("../workers/debugRuntimeProcess.worker.ts", import.meta.url),
        { type: "module", name: "cargo-debug-runtime-process" }
      )
    });
    const prepared = table.prepare({ cwd: "/workspace", projectId: "debug-session", url: resource });
    const started = await table.start(prepared.pid);
    if (started.status !== "ready") {
      table.teardown();
      throw new Error(`Debug runtime process failed to start: ${started.error || started.status}`);
    }
    const worker = table.registry.get(started.pid, started.generation) as Worker | null;
    if (!worker) {
      table.teardown();
      throw new Error("Debug runtime process worker was not registered.");
    }
    return new HostProcessDapTransport(table, started.pid, worker);
  }

  send(message: DapRequest): void {
    this.#worker.postMessage({ type: "dap", message });
  }

  subscribe(listener: (message: DapResponse | DapEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  dispose(): void {
    this.#worker.removeEventListener("message", this.#onMessage);
    this.#listeners.clear();
    this.#table.kill(this.#pid);
  }
}
