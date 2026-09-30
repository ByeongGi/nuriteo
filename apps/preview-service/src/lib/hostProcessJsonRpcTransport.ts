import { HostProcessTable } from "../../../../packages/browser-host/src/process/spawn.ts";
import { createPermissionManager } from "../../../../packages/browser-host/src/security/permissions.ts";
import type { JsonRpcMessage } from "./lspProtocol.ts";
import type { JsonRpcTransport } from "./jsonRpcClient.ts";

type ProtocolWorkerMessage =
  | { type: "rpc"; message: JsonRpcMessage }
  | { type: "ready" }
  | { type: "exit"; code: number };

export class HostProcessJsonRpcTransport implements JsonRpcTransport {
  readonly #table: HostProcessTable;
  readonly #pid: number;
  readonly #generation: number;
  readonly #worker: Worker;
  readonly #listeners = new Set<(message: JsonRpcMessage) => void>();
  readonly #onMessage: (event: MessageEvent<ProtocolWorkerMessage>) => void;

  private constructor(table: HostProcessTable, pid: number, generation: number, worker: Worker) {
    this.#table = table;
    this.#pid = pid;
    this.#generation = generation;
    this.#worker = worker;
    this.#onMessage = (event) => {
      if (event.data.type !== "rpc") return;
      for (const listener of this.#listeners) listener(event.data.message);
    };
    worker.addEventListener("message", this.#onMessage);
  }

  static async start(
    rootUri: string,
    options: {
      resource?: string;
      projectId?: string;
      createWorker?: () => Worker;
    } = {}
  ): Promise<HostProcessJsonRpcTransport> {
    const resource = options.resource || "worker://nuriteo/language-server";
    const permissions = createPermissionManager({
      defaultDecision: "deny",
      rules: [{ scope: "process", action: "prepare", resourcePrefix: resource, decision: "allow" }]
    });
    const table = new HostProcessTable({
      permissions,
      workerFactory: options.createWorker || (() => new Worker(
        new URL("../workers/languageServerProcess.worker.ts", import.meta.url),
        { type: "module", name: "nuriteo-language-server-process" }
      ))
    });
    const prepared = table.prepare({
      cwd: new URL(rootUri).pathname,
      projectId: options.projectId || rootUri,
      url: resource
    });
    const started = await table.start(prepared.pid);
    if (started.status !== "ready") {
      table.teardown();
      throw new Error(`Language server process failed to start: ${started.error || started.status}`);
    }
    const worker = table.registry.get(started.pid, started.generation) as Worker | null;
    if (!worker) {
      table.teardown();
      throw new Error("Language server process worker was not registered.");
    }
    return new HostProcessJsonRpcTransport(table, started.pid, started.generation, worker);
  }

  send(message: JsonRpcMessage): void {
    this.#worker.postMessage({ type: "rpc", message });
  }

  subscribe(listener: (message: JsonRpcMessage) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  dispose(): void {
    this.#worker.removeEventListener("message", this.#onMessage);
    this.#listeners.clear();
    this.#table.kill(this.#pid);
  }
}
