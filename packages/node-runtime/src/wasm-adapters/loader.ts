export class WasmAdapterError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "WasmAdapterError";
    this.code = code;
  }
}

export class WasmAdapterRegistry {
  constructor(manifest, options = {}) {
    this.manifest = manifest;
    this.root = options.root || process.cwd();
    this.readBytes = options.readBytes || readNodeFile;
    this.sha256 = options.sha256 || sha256Hex;
    this.adapters = new Map(manifest.adapters.map((adapter) => [adapter.name, adapter]));
  }

  resolve(name) {
    const adapter = this.adapters.get(name);
    if (!adapter) throw new WasmAdapterError(`unknown WASM adapter: ${name}`, "ENOADAPTER");
    return { ...adapter };
  }

  async instantiate(name, imports = {}) {
    const adapter = this.resolve(name);
    const bytes = await this.readBytes(adapter, this.root);
    const hash = await this.sha256(bytes);
    if (hash !== adapter.sha256) {
      throw new WasmAdapterError(`WASM integrity mismatch: ${name}`, "EINTEGRITY");
    }
    const { instance, module } = await WebAssembly.instantiate(bytes, imports);
    assertExports(instance.exports, adapter.exports || {});
    return { adapter, hash, instance, module };
  }
}

export function createWasmAdapterRegistry(manifest, options) {
  return new WasmAdapterRegistry(manifest, options);
}

export function rejectNativeAddon(packageName) {
  throw new WasmAdapterError(`native Node addon is unsupported without a WASM adapter: ${packageName}`, "ENATIVEADDON");
}

function assertExports(exports, contract) {
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

async function readNodeFile(adapter, root) {
  const [{ default: fs }, { default: path }] = await Promise.all([
    import("node:fs"),
    import("node:path")
  ]);
  return fs.readFileSync(path.resolve(root, adapter.path));
}

async function sha256Hex(bytes) {
  if (globalThis.crypto?.subtle) {
    const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  const { default: crypto } = await import("node:crypto");
  return crypto.createHash("sha256").update(bytes).digest("hex");
}
