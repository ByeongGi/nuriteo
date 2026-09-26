import { JsonRpcClient, WorkerJsonRpcTransport } from "./jsonRpcClient.ts";
import {
  assertExtensionCapability,
  verifyExtensionManifest,
  type SignedExtensionManifest
} from "./extensionManifest.ts";

export type ExtensionHostState = "stopped" | "verifying" | "active" | "recovering" | "failed";

export class BrowserExtensionHost {
  readonly #manifest: SignedExtensionManifest;
  readonly #createWorker: () => Worker;
  #client: JsonRpcClient | null = null;
  #state: ExtensionHostState = "stopped";
  #recoveryCount = 0;
  #disposed = false;

  constructor(
    manifest: SignedExtensionManifest,
    createWorker = () => new Worker(new URL("../workers/extensionHost.worker.ts", import.meta.url), {
      type: "module",
      name: `extension-${manifest.id}`
    })
  ) {
    this.#manifest = manifest;
    this.#createWorker = createWorker;
  }

  get state(): ExtensionHostState {
    return this.#state;
  }

  get recoveryCount(): number {
    return this.#recoveryCount;
  }

  async activate(): Promise<void> {
    this.#state = "verifying";
    await verifyExtensionManifest(this.#manifest);
    if (this.#disposed) return;
    await this.#spawnAndActivate();
    this.#state = "active";
  }

  async executeHelloCommand(): Promise<string> {
    assertExtensionCapability(this.#manifest, "commands.register");
    const result = await this.#request<{ message: string }>("workspace/executeCommand", {
      command: "cargo.workspaceTools.hello"
    });
    return result.message;
  }

  async simulateCrashAndRecover(): Promise<void> {
    if (this.#recoveryCount >= 1) throw new Error("Extension crash recovery budget exhausted.");
    try {
      await this.#request("extensionHost/crash", {}, 300);
      throw new Error("Extension crash probe unexpectedly returned.");
    } catch {
      this.#state = "recovering";
      this.#client?.dispose("Extension worker crashed.");
      this.#client = null;
      this.#recoveryCount += 1;
      await this.#spawnAndActivate();
      this.#state = "active";
    }
  }

  async deactivate(): Promise<void> {
    this.#disposed = true;
    const client = this.#client;
    this.#client = null;
    if (client) {
      try {
        await client.request("extensionHost/deactivate", {}, 1_000);
      } finally {
        client.dispose();
      }
    }
    this.#state = "stopped";
  }

  async #spawnAndActivate(): Promise<void> {
    if (this.#disposed) throw new Error("Extension host is disposed.");
    const client = new JsonRpcClient(new WorkerJsonRpcTransport(this.#createWorker()));
    this.#client = client;
    await client.request("extensionHost/activate", {
      id: this.#manifest.id,
      entrypoint: this.#manifest.entrypoint,
      capabilities: this.#manifest.capabilities
    });
  }

  #request<T>(method: string, params: unknown, timeoutMs?: number): Promise<T> {
    if (!this.#client) return Promise.reject(new Error("Extension host is not active."));
    return this.#client.request<T>(method, params, timeoutMs);
  }
}
