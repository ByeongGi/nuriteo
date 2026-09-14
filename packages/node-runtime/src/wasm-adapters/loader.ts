import type { WasmAdapterManifest, WasmAdapterManifestEntry, WasmExportKind } from "../types.ts";

export type WasmAdapterErrorCode = "EBADWASMEXPORT" | "EINTEGRITY" | "ENATIVEADDON" | "ENOADAPTER" | (string & {});

export interface WasmAdapterRegistryOptions {
  root?: string;
  readBytes?: (adapter: WasmAdapterManifestEntry, root: string) => Uint8Array | Promise<Uint8Array>;
  sha256?: (bytes: Uint8Array) => string | Promise<string>;
}

export class WasmAdapterError extends Error {
  code: WasmAdapterErrorCode;

  constructor(message: string, code: WasmAdapterErrorCode) {
    super(message);
    this.name = "WasmAdapterError";
    this.code = code;
  }
}

export class WasmAdapterRegistry {
  manifest: WasmAdapterManifest;
  root: string;
  readBytes: NonNullable<WasmAdapterRegistryOptions["readBytes"]>;
  sha256: NonNullable<WasmAdapterRegistryOptions["sha256"]>;
  adapters: Map<string, WasmAdapterManifestEntry>;

  constructor(manifest: WasmAdapterManifest, options: WasmAdapterRegistryOptions = {}) {
    this.manifest = manifest;
    this.root = options.root || process.cwd();
    this.readBytes = options.readBytes || readNodeFile;
    this.sha256 = options.sha256 || sha256Hex;
    this.adapters = new Map(manifest.adapters.map((adapter) => [adapter.name, adapter]));
  }

  resolve(name: string): WasmAdapterManifestEntry {
    const adapter = this.adapters.get(name);
    if (!adapter) throw new WasmAdapterError(`unknown WASM adapter: ${name}`, "ENOADAPTER");
    return { ...adapter };
  }

  async instantiate(name: string, imports: WebAssembly.Imports = {}): Promise<{
    adapter: WasmAdapterManifestEntry;
    hash: string;
    instance: WebAssembly.Instance;
    module: WebAssembly.Module;
  }> {
    const adapter = this.resolve(name);
    const bytes = await this.readBytes(adapter, this.root);
    const hash = await this.sha256(bytes);
    if (hash !== adapter.sha256) {
      throw new WasmAdapterError(`WASM integrity mismatch: ${name}`, "EINTEGRITY");
    }
    const module = await WebAssembly.compile(toBufferSource(bytes));
    const instance = await WebAssembly.instantiate(module, imports);
    assertExports(instance.exports, adapter.exports || {});
    return { adapter, hash, instance, module };
  }
}

export function createWasmAdapterRegistry(manifest: WasmAdapterManifest, options: WasmAdapterRegistryOptions = {}): WasmAdapterRegistry {
  return new WasmAdapterRegistry(manifest, options);
}

export function rejectNativeAddon(packageName: string): never {
  throw new WasmAdapterError(`native Node addon is unsupported without a WASM adapter: ${packageName}`, "ENATIVEADDON");
}

function assertExports(exports: WebAssembly.Exports, contract: Record<string, WasmExportKind>): void {
  for (const [name, expected] of Object.entries(contract)) {
    const value = exports[name];
    if (expected === "memory") {
      if (!(value instanceof WebAssembly.Memory)) {
        throw new WasmAdapterError(`missing WASM memory export: ${name}`, "EBADWASMEXPORT");
      }
    } else if (typeof value !== expected) {
      throw new WasmAdapterError(`missing WASM export: ${name}`, "EBADWASMEXPORT");
    }
  }
}

async function readNodeFile(adapter: WasmAdapterManifestEntry, root: string): Promise<Uint8Array> {
  const [{ default: fs }, { default: path }] = await Promise.all([
    import("node:fs"),
    import("node:path")
  ]);
  return fs.readFileSync(path.resolve(root, adapter.path));
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  if (globalThis.crypto?.subtle) {
    const digest = await globalThis.crypto.subtle.digest("SHA-256", toBufferSource(bytes));
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  const { default: crypto } = await import("node:crypto");
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function toBufferSource(bytes: Uint8Array): BufferSource {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}
