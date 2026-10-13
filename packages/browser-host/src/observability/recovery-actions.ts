import type { RuntimeDiagnostic, RuntimeSupportBundle } from "./support-bundle.ts";

export type RuntimeRecoveryActionKind =
  | "clear-cache"
  | "export-support-bundle"
  | "open-docs"
  | "reset-runtime"
  | "resolve-writer-conflict"
  | "retry";

export interface RuntimeRecoveryAction {
  kind: RuntimeRecoveryActionKind;
  label: string;
  reason: string;
  command?: string;
  href?: string;
}

export interface RuntimeRecoveryPlanInput {
  diagnostics: readonly RuntimeDiagnostic[];
  supportBundle?: RuntimeSupportBundle;
}

export interface RuntimeRecoveryPlan {
  actions: RuntimeRecoveryAction[];
  blocked: boolean;
  primaryMessage: string;
  supportBundleRecommended: boolean;
}

export function createRuntimeRecoveryPlan(input: RuntimeRecoveryPlanInput): RuntimeRecoveryPlan {
  const diagnostics = input.diagnostics;
  const actions = uniqueActions(diagnostics.flatMap(actionsForDiagnostic));
  const hasUnsupported = diagnostics.some(isUnsupportedDiagnostic);
  const hasError = diagnostics.some((diagnostic) => diagnostic.severity === "error");
  const supportBundleRecommended = hasError || diagnostics.length > 1 || Boolean(input.supportBundle);

  if (supportBundleRecommended) {
    actions.push({
      kind: "export-support-bundle",
      label: "Export support bundle",
      reason: "Attach logs, diagnostics, and trace context when the issue persists."
    });
  }

  return {
    actions: uniqueActions(actions),
    blocked: hasUnsupported,
    primaryMessage: primaryMessageFor(diagnostics, hasUnsupported),
    supportBundleRecommended
  };
}

function actionsForDiagnostic(diagnostic: RuntimeDiagnostic): RuntimeRecoveryAction[] {
  if (isUnsupportedDiagnostic(diagnostic)) {
    return [
      {
        kind: "open-docs",
        label: "View supported runtime scope",
        reason: diagnostic.remediation || "This feature is outside the browser-native runtime scope."
      }
    ];
  }
  if (diagnostic.code === "ENOSERVER" || diagnostic.code === "ETIMEOUT") {
    return [
      {
        kind: "retry",
        label: "Retry preview request",
        reason: "The preview server may have restarted or missed a transient request."
      },
      {
        kind: "reset-runtime",
        label: "Restart dev server",
        reason: "Recreate the dev server process and preview session."
      }
    ];
  }
  if (diagnostic.code === "EOPFSQUOTA") {
    return [
      {
        kind: "clear-cache",
        label: "Clear package cache",
        reason: "Free OPFS cache space before retrying install or build."
      },
      {
        kind: "retry",
        label: "Retry after cleanup",
        reason: "Retry install or build once cache space is available."
      }
    ];
  }
  if (diagnostic.code === "ELEASEHELD") {
    return [
      {
        kind: "resolve-writer-conflict",
        label: "Take over writer lease",
        reason: "Another tab holds the project writer lease. Take over after confirming the other tab is idle."
      },
      {
        kind: "retry",
        label: "Retry as reader",
        reason: "Wait for the other tab to release the writer lease, then retry."
      }
    ];
  }
  if (diagnostic.code.startsWith("ERR_PM_")) {
    return [
      {
        kind: "retry",
        label: "Retry package command",
        reason: "Retry after checking package scripts and dependency policy.",
        command: "npm install"
      }
    ];
  }
  return [
    {
      kind: "retry",
      label: "Retry operation",
      reason: "Retry the failed operation after reviewing the visible diagnostic."
    }
  ];
}

function isUnsupportedDiagnostic(diagnostic: RuntimeDiagnostic): boolean {
  const text = `${diagnostic.code} ${diagnostic.message} ${diagnostic.remediation || ""}`.toLowerCase();
  return text.includes("unsupported")
    || text.includes("native addon")
    || text.includes("docker")
    || text.includes("sync-require-of-async-esm")
    || text.includes("async-binding-namespace-not-ready")
    || text.includes("err_require_async_module")
    || text.includes("class extends value undefined")
    || text.includes("tcp db")
    || text.includes("tcp database");
}

function primaryMessageFor(diagnostics: readonly RuntimeDiagnostic[], hasUnsupported: boolean): string {
  if (diagnostics.length === 0) return "No recovery action is required.";
  if (hasUnsupported) return "This operation uses a feature that is outside the supported browser runtime scope.";
  const firstError = diagnostics.find((diagnostic) => diagnostic.severity === "error");
  return firstError?.message || diagnostics[0]?.message || "Review diagnostics and retry the operation.";
}

function uniqueActions(actions: RuntimeRecoveryAction[]): RuntimeRecoveryAction[] {
  const seen = new Set<RuntimeRecoveryActionKind>();
  const unique: RuntimeRecoveryAction[] = [];
  for (const action of actions) {
    if (seen.has(action.kind)) continue;
    seen.add(action.kind);
    unique.push(action);
  }
  return unique;
}
