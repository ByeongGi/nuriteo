import type { ExtensionCapability, SignedExtensionManifest } from "./extensionManifest.ts";
import { verifyExtensionManifest } from "./extensionManifest.ts";
import type {
  ExtensionActivationResult,
  ExtensionCommandResult,
  ExtensionDiagnosticsResult,
  ExtensionDocument
} from "./extensionRuntimeProtocol.ts";
import { HostProcessJsonRpcTransport } from "./hostProcessJsonRpcTransport.ts";
import { JsonRpcClient, type JsonRpcTransport } from "./jsonRpcClient.ts";

export type ExtensionHostState = "stopped" | "verifying" | "active" | "recovering" | "failed";

export class BrowserExtensionHost {
  readonly #manifest: SignedExtensionManifest;
  readonly #grantedCapabilities: ExtensionCapability[];
  readonly #createTransport: () => Promise<JsonRpcTransport>;
  #client: JsonRpcClient | null = null;
  #state: ExtensionHostState = "stopped";
  #recoveryCount = 0;
  #disposed = false;
  #activation: ExtensionActivationResult | null = null;

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

  get id(): string {
    return this.#manifest.id;
  }

  get manifest(): SignedExtensionManifest {
    return this.#manifest;
  }

  get state(): ExtensionHostState {
    return this.#state;
  }

  get recoveryCount(): number {
    return this.#recoveryCount;
  }

  get grants(): readonly ExtensionCapability[] {
    return this.#grantedCapabilities;
  }

  hasCapability(capability: ExtensionCapability): boolean {
    return this.#grantedCapabilities.includes(capability);
  }

  async activate(): Promise<ExtensionActivationResult> {
    if (this.#activation && this.#state === "active") return this.#activation;
    this.#state = "verifying";
    try {
      await verifyExtensionManifest(this.#manifest);
      if (this.#disposed) throw new Error("Extension host is disposed.");
      this.#activation = await this.#spawnAndActivate();
      this.#state = "active";
      return this.#activation;
    } catch (error) {
      this.#state = "failed";
      throw error;
    }
  }

  async executeCommand(command: string, document?: ExtensionDocument): Promise<ExtensionCommandResult> {
    this.#requireCapability("commands.register");
    if (!this.#manifest.contributes.commands?.some((contribution) => contribution.command === command)) {
      throw new Error(`Extension ${this.id} does not contribute ${command}.`);
    }
    return this.#request("workspace/executeCommand", { command, ...(document ? { document } : {}) });
  }

  async provideDiagnostics(document: ExtensionDocument): Promise<ExtensionDiagnosticsResult> {
    this.#requireCapability("languages.diagnostics");
    this.#requireCapability("workspace.read");
    if (!this.#manifest.contributes.languages?.includes(document.languageId)) return { diagnostics: [] };
    return this.#request("languages/provideDiagnostics", { document });
  }

  executeHelloCommand(): Promise<string> {
    return this.executeCommand("cargo.workspaceTools.hello").then((result) => result.message ?? "");
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
      this.#activation = null;
      this.#recoveryCount += 1;
      this.#activation = await this.#spawnAndActivate();
      this.#state = "active";
    }
  }

  async deactivate(): Promise<void> {
    this.#disposed = true;
    const client = this.#client;
    this.#client = null;
    this.#activation = null;
    if (client) {
      try {
        await client.request("extensionHost/deactivate", {}, 1_000);
      } finally {
        client.dispose();
      }
    }
    this.#state = "stopped";
  }

  async #spawnAndActivate(): Promise<ExtensionActivationResult> {
    if (this.#disposed) throw new Error("Extension host is disposed.");
    const client = new JsonRpcClient(await this.#createTransport());
    this.#client = client;
    return client.request("extensionHost/activate", {
      id: this.#manifest.id,
      entrypoint: this.#manifest.entrypoint,
      capabilities: this.#grantedCapabilities
    });
  }

  #request<T>(method: string, params: unknown, timeoutMs?: number): Promise<T> {
    if (!this.#client || this.#state !== "active") return Promise.reject(new Error("Extension host is not active."));
    return this.#client.request<T>(method, params, timeoutMs);
  }

  #requireCapability(capability: ExtensionCapability): void {
    if (!this.hasCapability(capability)) throw new Error(`Extension ${this.id} was not granted ${capability}.`);
  }
}
