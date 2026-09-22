export type SupportedPackageManager = "npm" | "pnpm";
export type PackageManagerDetectionSource =
  | "packageManager-field"
  | "pnpm-lock"
  | "package-lock"
  | "default"
  | "override";

export type OnboardingDiagnosticCode =
  | "ERR_IMPORT_ARCHIVE_FORMAT"
  | "ERR_IMPORT_FILE_TOO_LARGE"
  | "ERR_IMPORT_NETWORK"
  | "ERR_IMPORT_UNSUPPORTED_PACKAGE_MANAGER"
  | "ERR_IMPORT_MISSING_PACKAGE_JSON"
  | "ERR_IMPORT_INVALID_PACKAGE_JSON"
  | "ERR_IMPORT_LOCKFILE_CONFLICT"
  | "ERR_IMPORT_MISSING_SCRIPT"
  | "ERR_IMPORT_HEALTH"
  | "ERR_ABUSE_ARCHIVE_SIZE"
  | "ERR_ABUSE_WORKER_SPAWN"
  | "ERR_ABUSE_LOOP_ITERATIONS"
  | "ERR_ABUSE_MEMORY_GROWTH";

export interface OnboardingDiagnostic {
  code: OnboardingDiagnosticCode;
  level: "error" | "warning";
  message: string;
  recoveryHint?: string;
}

export interface PackageScriptDetection {
  packageManager: SupportedPackageManager;
  packageManagerSource: PackageManagerDetectionSource;
  installCommand: string;
  devScript: string | null;
  buildScript: string | null;
  scripts: Record<string, string>;
  diagnostics: OnboardingDiagnostic[];
  overrides: {
    packageManager?: SupportedPackageManager;
    installCommand?: string;
    devScript?: string;
    buildScript?: string;
  };
}

export interface DetectPackageScriptsInput {
  packageJsonText?: string | null;
  files?: Iterable<string>;
  overrides?: PackageScriptDetection["overrides"];
  defaultPackageManager?: SupportedPackageManager;
}

const SUPPORTED_MANAGERS = new Set<SupportedPackageManager>(["npm", "pnpm"]);

export function detectPackageScripts(input: DetectPackageScriptsInput = {}): PackageScriptDetection {
  const diagnostics: OnboardingDiagnostic[] = [];
  const files = new Set([...(input.files || [])].map(normalizePath));
  const overrides = input.overrides || {};
  const parsed = parsePackageJson(input.packageJsonText, diagnostics);
  const scripts = parsed?.scripts || {};

  let packageManager: SupportedPackageManager = input.defaultPackageManager || "npm";
  let packageManagerSource: PackageManagerDetectionSource = "default";

  const fieldManager = parsePackageManagerField(parsed?.packageManager);
  if (fieldManager === "npm" || fieldManager === "pnpm") {
    packageManager = fieldManager;
    packageManagerSource = "packageManager-field";
  } else if (fieldManager) {
    diagnostics.push({
      code: "ERR_IMPORT_UNSUPPORTED_PACKAGE_MANAGER",
      level: "error",
      message: `Unsupported packageManager field: ${parsed?.packageManager}`,
      recoveryHint: "Override the package manager to npm or pnpm."
    });
  } else if (files.has("pnpm-lock.yaml") || files.has("/pnpm-lock.yaml")) {
    packageManager = "pnpm";
    packageManagerSource = "pnpm-lock";
  } else if (files.has("package-lock.json") || files.has("/package-lock.json")) {
    packageManager = "npm";
    packageManagerSource = "package-lock";
  }

  const hasPnpmLock = [...files].some((file) => file.endsWith("pnpm-lock.yaml"));
  const hasNpmLock = [...files].some((file) => file.endsWith("package-lock.json"));
  if (hasPnpmLock && hasNpmLock) {
    diagnostics.push({
      code: "ERR_IMPORT_LOCKFILE_CONFLICT",
      level: "warning",
      message: "Both pnpm-lock.yaml and package-lock.json are present.",
      recoveryHint: "Choose one package manager override before install."
    });
  }

  if (overrides.packageManager) {
    if (!SUPPORTED_MANAGERS.has(overrides.packageManager)) {
      diagnostics.push({
        code: "ERR_IMPORT_UNSUPPORTED_PACKAGE_MANAGER",
        level: "error",
        message: `Unsupported package manager override: ${overrides.packageManager}`,
        recoveryHint: "Use npm or pnpm."
      });
    } else {
      packageManager = overrides.packageManager;
      packageManagerSource = "override";
    }
  }

  const installCommand = overrides.installCommand
    || (packageManager === "pnpm" ? "pnpm install" : "npm install");
  const devScript = overrides.devScript ?? pickScript(scripts, ["dev", "start"]);
  const buildScript = overrides.buildScript ?? pickScript(scripts, ["build"]);

  if (!devScript) {
    diagnostics.push({
      code: "ERR_IMPORT_MISSING_SCRIPT",
      level: "warning",
      message: "No dev/start script found in package.json.",
      recoveryHint: "Add a scripts.dev entry or override the dev script."
    });
  }
  if (!buildScript) {
    diagnostics.push({
      code: "ERR_IMPORT_MISSING_SCRIPT",
      level: "warning",
      message: "No build script found in package.json.",
      recoveryHint: "Add a scripts.build entry or override the build script."
    });
  }

  return {
    packageManager,
    packageManagerSource,
    installCommand,
    devScript,
    buildScript,
    scripts,
    diagnostics,
    overrides
  };
}

function parsePackageJson(
  text: string | null | undefined,
  diagnostics: OnboardingDiagnostic[]
): { scripts?: Record<string, string>; packageManager?: string } | null {
  if (text == null) {
    diagnostics.push({
      code: "ERR_IMPORT_MISSING_PACKAGE_JSON",
      level: "error",
      message: "package.json is missing from the imported project.",
      recoveryHint: "Import a Node project that includes package.json."
    });
    return null;
  }
  try {
    const value = JSON.parse(text) as {
      scripts?: Record<string, string>;
      packageManager?: string;
    };
    if (!value || typeof value !== "object") throw new Error("not an object");
    return {
      scripts: normalizeScripts(value.scripts),
      ...(typeof value.packageManager === "string" ? { packageManager: value.packageManager } : {})
    };
  } catch {
    diagnostics.push({
      code: "ERR_IMPORT_INVALID_PACKAGE_JSON",
      level: "error",
      message: "package.json could not be parsed as JSON.",
      recoveryHint: "Fix package.json syntax and re-import."
    });
    return null;
  }
}

function normalizeScripts(scripts: Record<string, string> | undefined): Record<string, string> {
  if (!scripts || typeof scripts !== "object") return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(scripts)) {
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

function parsePackageManagerField(value: string | undefined): SupportedPackageManager | "yarn" | "bun" | null {
  if (!value) return null;
  const name = value.split("@")[0]?.trim().toLowerCase();
  if (name === "npm" || name === "pnpm" || name === "yarn" || name === "bun") return name;
  return null;
}

function pickScript(scripts: Record<string, string>, names: string[]): string | null {
  for (const name of names) {
    if (scripts[name]) return name;
  }
  return null;
}

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/");
}
