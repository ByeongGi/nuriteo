import { WasmAdapterError } from "./loader.ts";
import type { WasmAdapterManifest, WasmAdapterReplacement } from "../types.ts";

export type WasmAdapterPolicyAction =
  | { packageName: string; action: "allow-js" }
  | { packageName: string; action: "use-wasm"; adapterName?: string; wasmPackage: string; fallbackPolicy: "prefer-wasm" | "deny-native" | "allow-js"; status?: string };

export class WasmAdapterPolicy {
  manifest: WasmAdapterManifest;
  replacements: Map<string, WasmAdapterReplacement>;

  constructor(manifest: WasmAdapterManifest) {
    this.manifest = manifest;
    this.replacements = new Map();
    for (const candidate of manifest.candidateReplacements || []) {
      if (candidate.package) this.replacements.set(candidate.package, candidate);
      for (const nativePackage of candidate.nativePackages || []) {
        this.replacements.set(nativePackage, candidate);
      }
    }
  }

  resolvePackage(packageName: string): WasmAdapterPolicyAction {
    const candidate = this.replacements.get(packageName);
    if (!candidate) return { packageName, action: "allow-js" };
    if (candidate.wasmPackage) {
      return {
        packageName,
        action: "use-wasm",
        ...(candidate.adapterName === undefined ? {} : { adapterName: candidate.adapterName }),
        wasmPackage: candidate.wasmPackage,
        fallbackPolicy: candidate.fallbackPolicy || "prefer-wasm",
        ...(candidate.status === undefined ? {} : { status: candidate.status })
      };
    }
    throw new WasmAdapterError(`native package requires explicit WASM adapter: ${packageName}`, "ENATIVEADDON");
  }
}

export function createWasmAdapterPolicy(manifest: WasmAdapterManifest): WasmAdapterPolicy {
  return new WasmAdapterPolicy(manifest);
}

export function verifyWasmAdapterManifest(manifest: WasmAdapterManifest): void {
  const adapters = new Set(manifest.adapters.map((adapter) => adapter.name));
  for (const adapter of manifest.adapters) {
    if (!/^[0-9a-f]{64}$/.test(adapter.sha256)) {
      throw new WasmAdapterError(`invalid WASM adapter hash: ${adapter.name}`, "EINTEGRITY");
    }
    if (!adapter.exports || Object.keys(adapter.exports).length === 0) {
      throw new WasmAdapterError(`missing WASM export contract: ${adapter.name}`, "EBADWASMEXPORT");
    }
  }
  for (const replacement of manifest.candidateReplacements || []) {
    if (replacement.adapterName && !adapters.has(replacement.adapterName)) {
      throw new WasmAdapterError(`unknown replacement adapter: ${replacement.adapterName}`, "ENOADAPTER");
    }
    if (replacement.wasmPackage && !replacement.fallbackPolicy) {
      throw new WasmAdapterError(`missing fallback policy for WASM package: ${replacement.wasmPackage}`, "ENATIVEADDON");
    }
  }
}
