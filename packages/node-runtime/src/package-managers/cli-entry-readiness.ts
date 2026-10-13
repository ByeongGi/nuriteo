import { dirname, extname, join } from "../builtins/path.ts";
import type { CliEntry } from "../types.ts";
import type { PackageManagerWorkspaceReader } from "./workspace.ts";

export type CliEntryModuleMode = "cjs" | "esm" | "unknown";
export type CliEntryReadinessStatus = "ready" | "blocked";
export type CliEntryReadinessReasonCode =
  | "ERR_CLI_ENTRY_MISSING"
  | "ERR_CLI_ESM_ENTRY_UNSUPPORTED"
  | "ERR_CLI_MODE_UNKNOWN";

export interface CliEntryReadinessReason {
  code: CliEntryReadinessReasonCode;
  message: string;
}

export interface CliEntryReadiness {
  status: CliEntryReadinessStatus;
  entry: string;
  mode: CliEntryModuleMode;
  reasons: CliEntryReadinessReason[];
  nextAction: string | null;
}

export interface InspectCliEntryReadinessOptions {
  entry: CliEntry;
  reader: PackageManagerWorkspaceReader;
  supportedModes?: readonly CliEntryModuleMode[];
}

export function inspectCliEntryReadiness(options: InspectCliEntryReadinessOptions): CliEntryReadiness {
  let source = "";
  try {
    source = options.reader.readText(options.entry.entry);
  } catch {
    return blocked(options.entry.entry, "unknown", {
      code: "ERR_CLI_ENTRY_MISSING",
      message: `CLI entrypoint is not readable: ${options.entry.entry}`
    });
  }

  const mode = classifyCliEntryModuleMode({
    entry: options.entry,
    reader: options.reader,
    source
  });
  const supportedModes = options.supportedModes || ["cjs"];
  if (!supportedModes.includes(mode) && mode === "esm") {
    return blocked(options.entry.entry, mode, {
      code: "ERR_CLI_ESM_ENTRY_UNSUPPORTED",
      message: `ESM CLI entrypoint requires async module entry execution: ${options.entry.entry}`
    });
  }
  if (mode === "unknown") {
    return blocked(options.entry.entry, mode, {
      code: "ERR_CLI_MODE_UNKNOWN",
      message: `CLI entrypoint module mode is unknown: ${options.entry.entry}`
    });
  }
  return {
    status: "ready",
    entry: options.entry.entry,
    mode,
    reasons: [],
    nextAction: null
  };
}

export function classifyCliEntryModuleMode(options: {
  entry: CliEntry;
  reader: PackageManagerWorkspaceReader;
  source?: string;
}): CliEntryModuleMode {
  if (options.entry.mode === "esm" || options.entry.mode === "module") return "esm";
  if (options.entry.mode === "cjs" || options.entry.mode === "commonjs") return "cjs";

  const extension = extname(options.entry.entry);
  if (extension === ".mjs") return "esm";
  if (extension === ".cjs") return "cjs";

  const source = options.source ?? safeReadText(options.reader, options.entry.entry);
  if (source && hasTopLevelImportSyntax(source)) return "esm";

  const packageType = findNearestPackageType(options.reader, options.entry.entry);
  if (packageType === "module") return "esm";
  if (packageType === "commonjs") return "cjs";
  if (extension === ".js") return "cjs";
  return "unknown";
}

function blocked(entry: string, mode: CliEntryModuleMode, reason: CliEntryReadinessReason): CliEntryReadiness {
  return {
    status: "blocked",
    entry,
    mode,
    reasons: [reason],
    nextAction: "Add async ESM CLI entry execution before routing this command through the browser guest runtime."
  };
}

function hasTopLevelImportSyntax(source: string): boolean {
  const withoutShebang = source.replace(/^#!.*(?:\n|$)/, "");
  return /^\s*import\s+(?:["'{*]|\w)/m.test(withoutShebang) || /^\s*export\s+(?:\{|\*|default|const|let|var|function|class)/m.test(withoutShebang);
}

function findNearestPackageType(reader: PackageManagerWorkspaceReader, entryPath: string): string | null {
  let current = dirname(entryPath);
  while (current !== "/") {
    const manifest = safeReadText(reader, join(current, "package.json"));
    if (manifest) {
      try {
        const parsed = JSON.parse(manifest) as { type?: unknown };
        if (parsed.type === "module" || parsed.type === "commonjs") return parsed.type;
      } catch {
        return null;
      }
    }
    current = dirname(current);
  }
  return null;
}

function safeReadText(reader: PackageManagerWorkspaceReader, path: string): string | null {
  try {
    return reader.readText(path);
  } catch {
    return null;
  }
}
