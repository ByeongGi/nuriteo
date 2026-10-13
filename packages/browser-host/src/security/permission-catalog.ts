import type { PermissionDecision, PermissionRequest, PermissionScope } from "./permissions.ts";

export type PermissionCatalogRisk = "low" | "medium" | "high";
export type PermissionCatalogScope = PermissionScope | "lifecycle";

export interface PermissionCatalogEntry {
  id: string;
  scope: PermissionCatalogScope;
  action: string;
  uiLabel: string;
  description: string;
  diagnosticCode: string;
  risk: PermissionCatalogRisk;
  defaultDecision: PermissionDecision;
  promptRequired: boolean;
}

export interface LifecyclePermissionDiagnostic {
  code: string;
  severity: "error";
  message: string;
  source: "permission:lifecycle";
  remediation: string;
  catalogId: string;
  command?: string;
  path?: string;
}

/** UI-facing permission catalog used by diagnostics and permission prompts. */
export const PERMISSION_CATALOG: readonly PermissionCatalogEntry[] = [
  {
    id: "lifecycle-script-run",
    scope: "lifecycle",
    action: "run",
    uiLabel: "Package lifecycle scripts",
    description: "Allow package install/prepare/postinstall lifecycle scripts to execute.",
    diagnosticCode: "ERR_PM_LIFECYCLE_BLOCKED",
    risk: "high",
    defaultDecision: "deny",
    promptRequired: true
  },
  {
    id: "network-fetch",
    scope: "network",
    action: "fetch",
    uiLabel: "Network fetch",
    description: "Allow outbound package registry and dependency downloads.",
    diagnosticCode: "EPERMISSION",
    risk: "high",
    defaultDecision: "deny",
    promptRequired: true
  },
  {
    id: "network-redirect",
    scope: "network",
    action: "redirect",
    uiLabel: "Network redirect",
    description: "Allow following redirects during authenticated downloads.",
    diagnosticCode: "EPERMISSION",
    risk: "high",
    defaultDecision: "deny",
    promptRequired: true
  },
  {
    id: "process-prepare",
    scope: "process",
    action: "prepare",
    uiLabel: "Process worker spawn",
    description: "Allow preparing runtime process workers for project commands.",
    diagnosticCode: "EPERMISSION",
    risk: "medium",
    defaultDecision: "deny",
    promptRequired: true
  },
  {
    id: "preview-relay",
    scope: "preview",
    action: "relay",
    uiLabel: "Preview relay",
    description: "Allow preview iframe traffic through the session-bound relay.",
    diagnosticCode: "EPERMISSION",
    risk: "medium",
    defaultDecision: "deny",
    promptRequired: false
  },
  {
    id: "filesystem-write",
    scope: "filesystem",
    action: "write",
    uiLabel: "Project filesystem write",
    description: "Allow writes inside the active project workspace boundary.",
    diagnosticCode: "EPERMISSION",
    risk: "medium",
    defaultDecision: "deny",
    promptRequired: false
  }
] as const;

export function listPermissionCatalog(scope?: PermissionCatalogScope): PermissionCatalogEntry[] {
  return PERMISSION_CATALOG.filter((entry) => scope === undefined || entry.scope === scope).map((entry) => ({ ...entry }));
}

export function findPermissionCatalogEntry(
  scope: PermissionCatalogScope,
  action: string
): PermissionCatalogEntry | null {
  return PERMISSION_CATALOG.find((entry) => entry.scope === scope && entry.action === action) || null;
}

export function createLifecyclePermissionDiagnostic(input: {
  command: string;
  path?: string;
}): LifecyclePermissionDiagnostic {
  const entry = findPermissionCatalogEntry("lifecycle", "run");
  const catalogId = entry?.id || "lifecycle-script-run";
  const code = entry?.diagnosticCode || "ERR_PM_LIFECYCLE_BLOCKED";
  return {
    code,
    severity: "error",
    message: `Package lifecycle script blocked: ${input.command}.`,
    source: "permission:lifecycle",
    remediation: "Review the lifecycle script permission policy in the UI catalog, then allow trusted scripts or keep them denied.",
    catalogId,
    command: input.command,
    ...(input.path ? { path: input.path } : {})
  };
}

export function permissionRequestFromCatalog(
  entry: PermissionCatalogEntry,
  resource: string,
  options: { projectId?: string; reason?: string } = {}
): PermissionRequest {
  if (entry.scope === "lifecycle") {
    return {
      scope: "process",
      action: `lifecycle:${entry.action}`,
      resource,
      ...(options.projectId ? { projectId: options.projectId } : {}),
      ...(options.reason ? { reason: options.reason } : { reason: entry.uiLabel })
    };
  }
  return {
    scope: entry.scope,
    action: entry.action,
    resource,
    ...(options.projectId ? { projectId: options.projectId } : {}),
    ...(options.reason ? { reason: options.reason } : { reason: entry.uiLabel })
  };
}
