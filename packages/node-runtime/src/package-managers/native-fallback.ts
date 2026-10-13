import type { WasmAdapterPolicy } from "../wasm-adapters/index.ts";

export type NativeFallbackAction = "allow-js" | "use-wasm" | "browser-polyfill" | "unsupported";

export interface NativeFallbackRequest {
  packageName?: string;
  command: string;
  path: string;
  source: string;
}

export interface NativeFallbackPolicyOptions {
  wasmPolicy?: WasmAdapterPolicy;
  browserPolyfills?: Record<string, string>;
}

export interface NativeFallbackDecision {
  action: NativeFallbackAction;
  packageName: string | null;
  reason: string;
  wasmPackage?: string;
  polyfillPackage?: string;
}

const nativePattern = /\.node(?:["'\s)]|$)|\bnode-gyp\b|\bprebuild-install\b|\bnode-pre-gyp\b/;

export class NativeFallbackPolicy {
  readonly wasmPolicy: WasmAdapterPolicy | null;
  readonly browserPolyfills: Map<string, string>;

  constructor(options: NativeFallbackPolicyOptions = {}) {
    this.wasmPolicy = options.wasmPolicy || null;
    this.browserPolyfills = new Map(Object.entries(options.browserPolyfills || {}));
  }

  classify(request: NativeFallbackRequest): NativeFallbackDecision {
    const packageName = request.packageName || inferPackageName(request.path);
    if (!containsNativeFallback(request.command, request.source)) {
      return {
        action: "allow-js",
        packageName,
        reason: "no native fallback pattern detected"
      };
    }

    if (packageName) {
      const polyfill = this.browserPolyfills.get(packageName);
      if (polyfill) {
        return {
          action: "browser-polyfill",
          packageName,
          polyfillPackage: polyfill,
          reason: `native fallback is replaced by browser polyfill ${polyfill}`
        };
      }
      if (this.wasmPolicy) {
        try {
          const resolved = this.wasmPolicy.resolvePackage(packageName);
          if (resolved.action === "use-wasm") {
            return {
              action: "use-wasm",
              packageName,
              wasmPackage: resolved.wasmPackage,
              reason: `native fallback is replaced by WASM package ${resolved.wasmPackage}`
            };
          }
        } catch {
          return unsupported(packageName);
        }
      }
    }
    return unsupported(packageName);
  }
}

export function createNativeFallbackPolicy(options: NativeFallbackPolicyOptions = {}): NativeFallbackPolicy {
  return new NativeFallbackPolicy(options);
}

export function containsNativeFallback(command: string, source: string): boolean {
  return nativePattern.test(`${command}\n${source}`);
}

export function inferPackageName(filePath: string): string | null {
  const parts = filePath.split("/").filter(Boolean);
  const nodeModules = parts.lastIndexOf("node_modules");
  if (nodeModules >= 0) {
    const first = parts[nodeModules + 1];
    if (!first) return null;
    if (first.startsWith("@")) {
      const second = parts[nodeModules + 2];
      return second ? `${first}/${second}` : null;
    }
    return first;
  }
  const packageIndex = parts.lastIndexOf("packages");
  if (packageIndex >= 0) return parts[packageIndex + 1] || null;
  return null;
}

function unsupported(packageName: string | null): NativeFallbackDecision {
  return {
    action: "unsupported",
    packageName,
    reason: packageName
      ? `native fallback is unsupported without a proven WASM adapter or browser polyfill: ${packageName}`
      : "native fallback is unsupported without a package name, WASM adapter, or browser polyfill"
  };
}
