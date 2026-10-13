import {
  detectPackageScripts,
  type OnboardingDiagnostic,
  type PackageScriptDetection,
  type SupportedPackageManager
} from "./package-detect.ts";

export interface ProjectHealthInput {
  files: Array<{ path: string; data: string }>;
  overrides?: PackageScriptDetection["overrides"];
  defaultPackageManager?: SupportedPackageManager;
}

export interface ProjectHealthReport {
  ok: boolean;
  packageJsonPath: string | null;
  detection: PackageScriptDetection;
  diagnostics: OnboardingDiagnostic[];
}

export function createProjectHealthCheck(input: ProjectHealthInput): ProjectHealthReport {
  const packageJson = input.files.find((file) => normalize(file.path) === "package.json"
    || normalize(file.path).endsWith("/package.json"));
  const detection = detectPackageScripts({
    packageJsonText: packageJson?.data ?? null,
    files: input.files.map((file) => file.path),
    ...(input.overrides ? { overrides: input.overrides } : {}),
    ...(input.defaultPackageManager ? { defaultPackageManager: input.defaultPackageManager } : {})
  });

  const diagnostics = [...detection.diagnostics];
  if (input.files.length === 0) {
    diagnostics.push({
      code: "ERR_IMPORT_HEALTH",
      level: "error",
      message: "Imported project has no files.",
      recoveryHint: "Choose another template, zip, or GitHub repository."
    });
  }

  const hasErrors = diagnostics.some((entry) => entry.level === "error");
  return {
    ok: !hasErrors,
    packageJsonPath: packageJson ? normalize(packageJson.path) : null,
    detection,
    diagnostics
  };
}

function normalize(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "").replace(/^\/+/, "");
}
