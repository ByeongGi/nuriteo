import type { PermissionDeniedError, PermissionRequest } from "../security/index.ts";
import { createRuntimeRecoveryPlan, type RuntimeRecoveryPlan } from "./recovery-actions.ts";
import { createRuntimeSupportBundle, type RuntimeDiagnostic, type RuntimeSupportBundle } from "./support-bundle.ts";

export interface PermissionRecoveryDiagnostic {
  diagnostic: RuntimeDiagnostic;
  recoveryPlan: RuntimeRecoveryPlan;
  supportBundle: RuntimeSupportBundle;
}

export type PermissionDiagnosticInput = PermissionDeniedError | {
  code?: string;
  message?: string;
  request?: PermissionRequest;
};

export function createPermissionDeniedDiagnostic(input: PermissionDiagnosticInput): RuntimeDiagnostic {
  const request = input.request;
  const source = request ? `permission:${request.scope}` : "permission";
  const resource = request?.resource ? ` ${request.resource}` : "";
  const action = request ? `${request.scope}:${request.action}` : "runtime operation";
  return {
    code: input.code || "EPERMISSION",
    severity: "error",
    message: `Permission denied for ${action}${resource}.`,
    source,
    remediation: "Review the workspace permission policy, then retry the operation or export a support bundle."
  };
}

export function createPermissionRecoveryDiagnostic(
  input: PermissionDiagnosticInput,
  logs: readonly string[] = []
): PermissionRecoveryDiagnostic {
  const diagnostic = createPermissionDeniedDiagnostic(input);
  const supportBundle = createRuntimeSupportBundle({
    diagnostics: [diagnostic],
    logs,
    environment: input.request
      ? {
          permissionScope: input.request.scope,
          permissionAction: input.request.action,
          permissionProjectId: input.request.projectId || null
        }
      : {}
  });
  return {
    diagnostic,
    supportBundle,
    recoveryPlan: createRuntimeRecoveryPlan({ diagnostics: [diagnostic], supportBundle })
  };
}
