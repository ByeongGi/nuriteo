import { containsNativeFallback, createNativeFallbackPolicy, type NativeFallbackPolicy } from "./native-fallback.ts";

export type PackageScriptKind = "script" | "lifecycle" | "bin";

export type PackageExecutionPolicyErrorCode =
  | "ERR_PM_LIFECYCLE_BLOCKED"
  | "ERR_PM_NATIVE_ADDON_UNSUPPORTED"
  | "ERR_PM_RESOURCE_LIMIT"
  | (string & {});

export interface PackageScriptPolicyCheck {
  kind: PackageScriptKind;
  command: string;
  path: string;
  source: string;
}

export interface PackageExecutionPolicyOptions {
  lifecycleScripts?: "allow" | "deny";
  blockNativeAddons?: boolean;
  maxScriptBytes?: number;
  nativeFallbackPolicy?: NativeFallbackPolicy;
}

export class PackageExecutionPolicyError extends Error {
  code: PackageExecutionPolicyErrorCode;

  constructor(message: string, code: PackageExecutionPolicyErrorCode) {
    super(message);
    this.name = "PackageExecutionPolicyError";
    this.code = code;
  }
}

export class PackageExecutionPolicy {
  readonly lifecycleScripts: "allow" | "deny";
  readonly blockNativeAddons: boolean;
  readonly maxScriptBytes: number;
  readonly nativeFallbackPolicy: NativeFallbackPolicy;

  constructor(options: PackageExecutionPolicyOptions = {}) {
    this.lifecycleScripts = options.lifecycleScripts || "allow";
    this.blockNativeAddons = options.blockNativeAddons ?? true;
    this.maxScriptBytes = options.maxScriptBytes ?? 512 * 1024;
    this.nativeFallbackPolicy = options.nativeFallbackPolicy || createNativeFallbackPolicy();
  }

  assertAllowed(check: PackageScriptPolicyCheck): void {
    if (check.kind === "lifecycle" && this.lifecycleScripts === "deny") {
      throw new PackageExecutionPolicyError(`blocked package lifecycle script: ${check.command}`, "ERR_PM_LIFECYCLE_BLOCKED");
    }
    if (new TextEncoder().encode(check.source).byteLength > this.maxScriptBytes) {
      throw new PackageExecutionPolicyError(`package script exceeded ${this.maxScriptBytes} bytes: ${check.path}`, "ERR_PM_RESOURCE_LIMIT");
    }
    if (this.blockNativeAddons && containsNativeFallback(check.command, check.source)) {
      const decision = this.nativeFallbackPolicy.classify(check);
      if (decision.action === "unsupported") {
        throw new PackageExecutionPolicyError(`native addon execution is unsupported: ${check.command}; ${decision.reason}`, "ERR_PM_NATIVE_ADDON_UNSUPPORTED");
      }
    }
  }
}

export function createPackageExecutionPolicy(options: PackageExecutionPolicyOptions = {}): PackageExecutionPolicy {
  return new PackageExecutionPolicy(options);
}
