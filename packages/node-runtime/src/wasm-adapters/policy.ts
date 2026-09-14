import { WasmAdapterError } from "./loader.ts";
import type { WasmAdapterManifest, WasmAdapterReplacement } from "../types.ts";

export type WasmAdapterPolicyAction =
  | { packageName: string; action: "allow-js" }
  | { packageName: string; action: "use-wasm"; wasmPackage: string; status?: string };

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
        wasmPackage: candidate.wasmPackage,
        ...(candidate.status === undefined ? {} : { status: candidate.status })
      };
    }
    throw new WasmAdapterError(`native package requires explicit WASM adapter: ${packageName}`, "ENATIVEADDON");
  }
}

export function createWasmAdapterPolicy(manifest: WasmAdapterManifest): WasmAdapterPolicy {
  return new WasmAdapterPolicy(manifest);
}
