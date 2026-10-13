import { createRuntimeRecoveryPlan, type RuntimeRecoveryPlan } from "./recovery-actions.ts";
import { createRuntimeSupportBundle, type RuntimeDiagnostic, type RuntimeSupportBundle } from "./support-bundle.ts";
import { createUnsupportedRuntimeDiagnostic } from "./unsupported-runtime.ts";

export interface RuntimeNetworkDiagnosticInput {
  command?: string;
  error?: {
    code?: string;
    message?: string;
  };
  host?: string;
  port?: number;
  requestId?: string | number;
  resource?: string;
  url?: string;
}

export interface RuntimeNetworkRecoveryDiagnostic {
  diagnostic: RuntimeDiagnostic;
  recovery: RuntimeRecoveryPlan;
  supportBundle: RuntimeSupportBundle;
}

export function createRuntimeNetworkUnsupportedDiagnostic(
  input: RuntimeNetworkDiagnosticInput
): RuntimeDiagnostic | null {
  if (!isDirectTcpDatabaseRequest(input)) return null;
  return createUnsupportedRuntimeDiagnostic({
    kind: "direct-tcp-database",
    resource: networkResource(input),
    source: "network",
    ...(input.command ? { command: input.command } : {}),
    ...(input.requestId !== undefined ? { requestId: input.requestId } : {})
  });
}

export function createRuntimeNetworkRecoveryDiagnostic(
  input: RuntimeNetworkDiagnosticInput,
  logs: readonly string[] = []
): RuntimeNetworkRecoveryDiagnostic | null {
  const diagnostic = createRuntimeNetworkUnsupportedDiagnostic(input);
  if (!diagnostic) return null;
  const supportBundle = createRuntimeSupportBundle({
    diagnostics: [diagnostic],
    logs: [...logs, input.error?.message || ""].filter(Boolean)
  });
  return {
    diagnostic,
    recovery: createRuntimeRecoveryPlan({
      diagnostics: supportBundle.diagnostics,
      supportBundle
    }),
    supportBundle
  };
}

function isDirectTcpDatabaseRequest(input: RuntimeNetworkDiagnosticInput): boolean {
  if (input.error?.code === "ERR_BROWSER_TCP_UNSUPPORTED" && isDatabaseEndpoint(input)) return true;
  if (input.url && isDatabaseUrl(input.url)) return true;
  if (input.resource && isDatabaseUrl(input.resource)) return true;
  return false;
}

function isDatabaseEndpoint(input: RuntimeNetworkDiagnosticInput): boolean {
  const endpoint = `${input.host || ""}:${input.port || ""} ${input.resource || ""} ${input.command || ""}`.toLowerCase();
  if (input.port !== undefined && databasePorts.has(input.port)) return true;
  return databaseTokens.some((token) => endpoint.includes(token));
}

function isDatabaseUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    if (databaseProtocols.has(parsed.protocol)) return true;
    if (parsed.port && databasePorts.has(Number(parsed.port))) return true;
    return databaseTokens.some((token) => parsed.hostname.toLowerCase().includes(token));
  } catch {
    return databaseTokens.some((token) => value.toLowerCase().includes(token));
  }
}

function networkResource(input: RuntimeNetworkDiagnosticInput): string {
  if (input.resource) return input.resource;
  if (input.url) return input.url;
  if (input.host) return `${input.host}${input.port === undefined ? "" : `:${input.port}`}`;
  return "direct TCP database";
}

const databasePorts = new Set([3306, 5432, 6379, 27017, 9200]);
const databaseProtocols = new Set(["mysql:", "postgres:", "postgresql:", "redis:", "mongodb:", "mariadb:"]);
const databaseTokens = ["database", "postgres", "postgresql", "mysql", "mariadb", "redis", "mongodb", "mongo", "elasticsearch"];
