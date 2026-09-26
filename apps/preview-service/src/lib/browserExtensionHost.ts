import { JsonRpcClient } from "./jsonRpcClient.ts";
import type { JsonRpcTransport } from "./jsonRpcClient.ts";
import { HostProcessJsonRpcTransport } from "./hostProcessJsonRpcTransport.ts";
import {
  verifyExtensionManifest,
  type ExtensionCapability,
  type SignedExtensionManifest
} from "./extensionManifest.ts";

export type ExtensionHostState = "stopped" | "verifying" | "active" | "recovering" | "failed";

export class BrowserExtensionHost {
  readonly #manifest: SignedExtensionManifest;
  readonly #grantedCapabilities: ExtensionCapability[];
  readonly #createTransport: () => Promise<JsonRpcTransport>;
  #client: JsonRpcClient | null = null;
  #state: ExtensionHostState = "stopped";
  #recoveryCount = 0;
  #disposed = false;

  constructor(
    manifest: SignedExtensionManifest,
    grantedCapabilities: ExtensionCapability[] = manifest.capabilities,
    createTransport = () => HostProcessJsonRpcTransport.start(
      "file:///workspace",
      {
        resource: `worker://cargo/extensions/${manifest.id}`,
        projectId: manifest.id,
        createWorker: () => new Worker(
          new URL("../workers/extensionHost.worker.ts", import.meta.url),
          { type: "module", name: `extension-${manifest.id}` }
        )
      }
    )
  ) {
    this.#manifest = manifest;
    this.#grantedCapabilities = grantedCapabilities.filter((capability) => manifest.capabilities.includes(capability));
    this.#createTransport = createTransport;
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
    if (!this.#grantedCapabilities.includes("commands.register")) {
      throw new Error(`Extension ${this.#manifest.id} was not granted commands.register.`);
    }
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
    const client = new JsonRpcClient(await this.#createTransport());
    this.#client = client;
    await client.request("extensionHost/activate", {
      id: this.#manifest.id,
      entrypoint: this.#manifest.entrypoint,
      capabilities: this.#grantedCapabilities
    });
  }

  #request<T>(method: string, params: unknown, timeoutMs?: number): Promise<T> {
    if (!this.#client) return Promise.reject(new Error("Extension host is not active."));
    return this.#client.request<T>(method, params, timeoutMs);
  }
}
