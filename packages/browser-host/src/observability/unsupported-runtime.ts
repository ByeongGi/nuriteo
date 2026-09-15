import type { RuntimeDiagnostic } from "./support-bundle.ts";

export type UnsupportedRuntimeFeatureKind =
  | "arbitrary-linux-binary"
  | "direct-tcp-database"
  | "docker"
  | "native-addon";

export type UnsupportedRuntimeFeatureErrorCode =
  | "ERR_PM_NATIVE_ADDON_UNSUPPORTED"
  | "ERR_RUNTIME_DOCKER_UNSUPPORTED"
  | "ERR_RUNTIME_TCP_DB_UNSUPPORTED"
  | "ERR_RUNTIME_UNSUPPORTED_BINARY";

export interface UnsupportedRuntimeFeatureInput {
  kind: UnsupportedRuntimeFeatureKind;
  resource: string;
  command?: string;
  requestId?: string | number;
  source?: string;
}

export class UnsupportedRuntimeFeatureError extends Error {
  code: UnsupportedRuntimeFeatureErrorCode;
  diagnostic: RuntimeDiagnostic;

  constructor(input: UnsupportedRuntimeFeatureInput) {
    const diagnostic = createUnsupportedRuntimeDiagnostic(input);
    super(diagnostic.message);
    this.name = "UnsupportedRuntimeFeatureError";
    this.code = diagnostic.code as UnsupportedRuntimeFeatureErrorCode;
    this.diagnostic = diagnostic;
  }
}

export function createUnsupportedRuntimeDiagnostic(input: UnsupportedRuntimeFeatureInput): RuntimeDiagnostic {
  const code = unsupportedCode(input.kind);
  return {
    code,
    severity: "error",
    source: input.source || "runtime",
    message: unsupportedMessage(input),
    remediation: unsupportedRemediation(input.kind),
    ...(input.requestId !== undefined ? { requestId: input.requestId } : {})
  };
}

export function assertRuntimeFeatureSupported(input: UnsupportedRuntimeFeatureInput): never {
  throw new UnsupportedRuntimeFeatureError(input);
}

function unsupportedCode(kind: UnsupportedRuntimeFeatureKind): UnsupportedRuntimeFeatureErrorCode {
  if (kind === "docker") return "ERR_RUNTIME_DOCKER_UNSUPPORTED";
  if (kind === "direct-tcp-database") return "ERR_RUNTIME_TCP_DB_UNSUPPORTED";
  if (kind === "native-addon") return "ERR_PM_NATIVE_ADDON_UNSUPPORTED";
  return "ERR_RUNTIME_UNSUPPORTED_BINARY";
}

function unsupportedMessage(input: UnsupportedRuntimeFeatureInput): string {
  const command = input.command ? ` command "${input.command}"` : "";
  if (input.kind === "docker") return `Docker${command} is unsupported in the browser runtime: ${input.resource}`;
  if (input.kind === "direct-tcp-database") return `Direct TCP database access is unsupported in the browser runtime: ${input.resource}`;
  if (input.kind === "native-addon") return `Native addon execution is unsupported in the browser runtime: ${input.resource}`;
  return `Arbitrary Linux binary execution is unsupported in the browser runtime: ${input.resource}`;
}

function unsupportedRemediation(kind: UnsupportedRuntimeFeatureKind): string {
  if (kind === "docker") return "Use a browser-compatible service mock, HTTP API, or external hosted service instead of Docker.";
  if (kind === "direct-tcp-database") return "Use an HTTP adapter, embedded WASM database, or mocked database API; direct TCP sockets are outside browser scope.";
  if (kind === "native-addon") return "Use a pure JavaScript, WASM, or browser polyfill package when available.";
  return "Use a JavaScript or pinned WASM adapter with a bounded browser runtime contract.";
}
