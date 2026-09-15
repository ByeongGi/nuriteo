import { createRuntimeRecoveryPlan, type RuntimeRecoveryPlan } from "./recovery-actions.ts";
import { createRuntimeSupportBundle, type RuntimeDiagnostic, type RuntimeSupportBundle } from "./support-bundle.ts";
import { createUnsupportedRuntimeDiagnostic } from "./unsupported-runtime.ts";

export interface PackageManagerDiagnosticResult {
  args?: readonly string[];
  commandKind?: string;
  cwd?: string;
  entry?: string;
  error?: {
    code?: string;
    message: string;
    nextAction?: string;
  };
  stderr?: string;
}

export interface PackageManagerRecoveryDiagnostic {
  diagnostic: RuntimeDiagnostic;
  recovery: RuntimeRecoveryPlan;
  supportBundle: RuntimeSupportBundle;
}

export function createPackageManagerUnsupportedDiagnostic(
  result: PackageManagerDiagnosticResult
): RuntimeDiagnostic | null {
  if (result.error?.code !== "ERR_PM_NATIVE_ADDON_UNSUPPORTED") return null;
  return createUnsupportedRuntimeDiagnostic({
    kind: "native-addon",
    resource: packageManagerResource(result),
    command: packageManagerCommand(result),
    source: "package-manager"
  });
}

export function createPackageManagerRecoveryDiagnostic(
  result: PackageManagerDiagnosticResult,
  logs: readonly string[] = []
): PackageManagerRecoveryDiagnostic | null {
  const diagnostic = createPackageManagerUnsupportedDiagnostic(result);
  if (!diagnostic) return null;
  const supportBundle = createRuntimeSupportBundle({
    diagnostics: [diagnostic],
    logs: [...logs, result.stderr || result.error?.message || ""].filter(Boolean)
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

function packageManagerResource(result: PackageManagerDiagnosticResult): string {
  return result.entry || result.commandKind || "package-manager";
}

function packageManagerCommand(result: PackageManagerDiagnosticResult): string {
  return [result.entry, ...(result.args || [])].filter(Boolean).join(" ") || "package-manager";
}
