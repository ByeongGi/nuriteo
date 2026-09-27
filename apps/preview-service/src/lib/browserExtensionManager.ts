import { BrowserExtensionHost, type ExtensionHostState } from "./browserExtensionHost.ts";
import type { ExtensionCapability, SignedExtensionManifest } from "./extensionManifest.ts";
import { verifyExtensionManifest } from "./extensionManifest.ts";
import type { ExtensionCommandResult, ExtensionDocument } from "./extensionRuntimeProtocol.ts";
import type { LspDiagnostic } from "./lspProtocol.ts";

export interface ExtensionStatus {
  id: string;
  name: string;
  state: ExtensionHostState;
  grants: readonly ExtensionCapability[];
  recoveryCount: number;
  error?: string;
}

export interface ExtensionManagerSnapshot {
  extensions: ExtensionStatus[];
}

type HostFactory = (manifest: SignedExtensionManifest, grants: ExtensionCapability[]) => BrowserExtensionHost;

export class BrowserExtensionManager {
  readonly #manifests: SignedExtensionManifest[];
  readonly #grants: Readonly<Record<string, ExtensionCapability[]>>;
  readonly #hostFactory: HostFactory;
  readonly #hosts = new Map<string, BrowserExtensionHost>();
  readonly #errors = new Map<string, string>();
  readonly #listeners = new Set<(snapshot: ExtensionManagerSnapshot) => void>();
  #disposed = false;

  constructor(
    manifests: readonly SignedExtensionManifest[],
    grants: Readonly<Record<string, ExtensionCapability[]>> = {},
    hostFactory: HostFactory = (manifest, capabilities) => new BrowserExtensionHost(manifest, capabilities)
  ) {
    this.#manifests = [...manifests];
    this.#grants = grants;
    this.#hostFactory = hostFactory;
    assertUniqueContributions(this.#manifests);
  }

  get snapshot(): ExtensionManagerSnapshot {
    return {
      extensions: this.#manifests.map((manifest) => {
        const host = this.#hosts.get(manifest.id);
        return {
          id: manifest.id,
          name: extensionName(manifest.id),
          state: host?.state ?? "stopped",
          grants: host?.grants ?? this.#capabilitiesFor(manifest),
          recoveryCount: host?.recoveryCount ?? 0,
          ...(this.#errors.has(manifest.id) ? { error: this.#errors.get(manifest.id) } : {})
        };
      })
    };
  }

  subscribe(listener: (snapshot: ExtensionManagerSnapshot) => void): () => void {
    this.#listeners.add(listener);
    listener(this.snapshot);
    return () => this.#listeners.delete(listener);
  }

  async start(): Promise<void> {
    this.#assertAvailable();
    await Promise.all(this.#manifests.map((manifest) => verifyExtensionManifest(manifest)));
    await this.#activateWhere((manifest) => manifest.activationEvents.includes("onStartup"));
  }

  async executeCommand(command: string, document?: ExtensionDocument): Promise<ExtensionCommandResult> {
    this.#assertAvailable();
    const manifest = this.#manifests.find((candidate) =>
      candidate.contributes.commands?.some((contribution) => contribution.command === command)
    );
    if (!manifest) throw new Error(`No extension contributes command ${command}.`);
    const host = await this.#activate(manifest);
    const result = await host.executeCommand(command, document);
    if (result.edit && !host.hasCapability("workspace.write")) {
      throw new Error(`Extension ${manifest.id} returned a workspace edit without workspace.write.`);
    }
    return result;
  }

  async provideDiagnostics(document: ExtensionDocument): Promise<LspDiagnostic[]> {
    this.#assertAvailable();
    const manifests = this.#manifests.filter((manifest) => manifest.contributes.languages?.includes(document.languageId));
    const settled = await Promise.allSettled(manifests.map(async (manifest) => {
      const host = await this.#activate(manifest);
      return (await host.provideDiagnostics(document)).diagnostics;
    }));
    return settled.flatMap((result) => result.status === "fulfilled" ? result.value : []);
  }

  async recover(extensionId: string): Promise<void> {
    const manifest = this.#manifest(extensionId);
    const host = this.#hosts.get(manifest.id);
    if (!host || host.state !== "active") throw new Error(`Extension ${extensionId} is not active.`);
    await host.simulateCrashAndRecover();
    this.#errors.delete(extensionId);
    this.#publish();
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    await Promise.allSettled([...this.#hosts.values()].map((host) => host.deactivate()));
    this.#hosts.clear();
    this.#listeners.clear();
  }

  async #activateWhere(predicate: (manifest: SignedExtensionManifest) => boolean): Promise<void> {
    const settled = await Promise.allSettled(this.#manifests.filter(predicate).map((manifest) => this.#activate(manifest)));
    const failure = settled.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failure) throw failure.reason;
  }

  async #activate(manifest: SignedExtensionManifest): Promise<BrowserExtensionHost> {
    let host = this.#hosts.get(manifest.id);
    if (!host) {
      host = this.#hostFactory(manifest, this.#capabilitiesFor(manifest));
      this.#hosts.set(manifest.id, host);
      this.#publish();
    }
    if (host.state === "active") return host;
    try {
      await host.activate();
      this.#errors.delete(manifest.id);
      this.#publish();
      return host;
    } catch (error) {
      this.#errors.set(manifest.id, error instanceof Error ? error.message : String(error));
      this.#publish();
      throw error;
    }
  }

  #capabilitiesFor(manifest: SignedExtensionManifest): ExtensionCapability[] {
    const configured = this.#grants[manifest.id] ?? manifest.capabilities;
    return configured.filter((capability) => manifest.capabilities.includes(capability));
  }

  #manifest(extensionId: string): SignedExtensionManifest {
    const manifest = this.#manifests.find((candidate) => candidate.id === extensionId);
    if (!manifest) throw new Error(`Unknown extension ${extensionId}.`);
    return manifest;
  }

  #assertAvailable(): void {
    if (this.#disposed) throw new Error("Extension manager is disposed.");
  }

  #publish(): void {
    const snapshot = this.snapshot;
    for (const listener of this.#listeners) listener(snapshot);
  }
}

function assertUniqueContributions(manifests: SignedExtensionManifest[]): void {
  const commands = new Set<string>();
  for (const manifest of manifests) {
    for (const contribution of manifest.contributes.commands ?? []) {
      if (commands.has(contribution.command)) throw new Error(`Duplicate extension command: ${contribution.command}`);
      commands.add(contribution.command);
    }
  }
}

function extensionName(id: string): string {
  return id.split(".").at(-1)?.split("-").map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`).join(" ") || id;
}
