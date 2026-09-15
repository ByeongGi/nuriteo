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

  constructor(options: PackageExecutionPolicyOptions = {}) {
    this.lifecycleScripts = options.lifecycleScripts || "allow";
    this.blockNativeAddons = options.blockNativeAddons ?? true;
    this.maxScriptBytes = options.maxScriptBytes ?? 512 * 1024;
  }

  assertAllowed(check: PackageScriptPolicyCheck): void {
    if (check.kind === "lifecycle" && this.lifecycleScripts === "deny") {
      throw new PackageExecutionPolicyError(`blocked package lifecycle script: ${check.command}`, "ERR_PM_LIFECYCLE_BLOCKED");
    }
    if (new TextEncoder().encode(check.source).byteLength > this.maxScriptBytes) {
      throw new PackageExecutionPolicyError(`package script exceeded ${this.maxScriptBytes} bytes: ${check.path}`, "ERR_PM_RESOURCE_LIMIT");
    }
    if (this.blockNativeAddons && includesNativeAddonPattern(check.command, check.source)) {
      throw new PackageExecutionPolicyError(`native addon execution is unsupported: ${check.command}`, "ERR_PM_NATIVE_ADDON_UNSUPPORTED");
    }
  }
}

export function createPackageExecutionPolicy(options: PackageExecutionPolicyOptions = {}): PackageExecutionPolicy {
  return new PackageExecutionPolicy(options);
}

function includesNativeAddonPattern(command: string, source: string): boolean {
  const text = `${command}\n${source}`;
  return /\.node(?:["'\s)]|$)/.test(text)
    || /\bnode-gyp\b/.test(text)
    || /\bprebuild-install\b/.test(text)
    || /\bnode-pre-gyp\b/.test(text);
}
