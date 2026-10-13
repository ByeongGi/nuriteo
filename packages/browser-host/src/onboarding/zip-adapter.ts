import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import {
  checkAbuse,
  createAbuseLimitPolicy,
  DEFAULT_ABUSE_LIMIT_POLICY,
  type AbuseLimitPolicy
} from "../security/abuse-limits.ts";
import type { OnboardingDiagnostic, OnboardingDiagnosticCode } from "./package-detect.ts";

export interface ZipProjectFile {
  path: string;
  data: string;
}

export interface ZipImportResult {
  files: ZipProjectFile[];
  rootPrefix: string;
  diagnostics: OnboardingDiagnostic[];
}

export interface ZipExportInput {
  files: ZipProjectFile[];
  rootDirectory?: string;
}

const DEFAULT_MAX_BYTES = DEFAULT_ABUSE_LIMIT_POLICY.maxArchiveBytes;
const DEFAULT_MAX_FILES = 5000;

export function importProjectZip(
  input: Uint8Array | ArrayBuffer,
  options: { maxBytes?: number; maxFiles?: number; abusePolicy?: AbuseLimitPolicy; projectId?: string } = {}
): ZipImportResult {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const diagnostics: OnboardingDiagnostic[] = [];
  const abusePolicy = options.abusePolicy || createAbuseLimitPolicy({ maxArchiveBytes: maxBytes });
  const abuse = checkAbuse({
    kind: "archive",
    archiveBytes: bytes.byteLength,
    ...(options.projectId ? { projectId: options.projectId } : {})
  }, abusePolicy);
  if (abuse.decision === "deny" && abuse.diagnostic) {
    return {
      files: [],
      rootPrefix: "",
      diagnostics: [{
        code: abuse.diagnostic.code as OnboardingDiagnosticCode,
        level: "error",
        message: abuse.diagnostic.message,
        recoveryHint: abuse.diagnostic.remediation
      }]
    };
  }

  if (bytes.byteLength > maxBytes) {
    return {
      files: [],
      rootPrefix: "",
      diagnostics: [{
        code: "ERR_IMPORT_FILE_TOO_LARGE",
        level: "error",
        message: `Archive exceeds size limit (${bytes.byteLength} > ${maxBytes} bytes).`,
        recoveryHint: "Import a smaller project archive or raise the size limit."
      }]
    };
  }

  let extracted: Record<string, Uint8Array>;
  try {
    extracted = unzipSync(bytes);
  } catch (error) {
    return {
      files: [],
      rootPrefix: "",
      diagnostics: [{
        code: "ERR_IMPORT_ARCHIVE_FORMAT",
        level: "error",
        message: error instanceof Error ? error.message : "Unable to read zip archive.",
        recoveryHint: "Provide a valid .zip created from a project directory."
      }]
    };
  }

  const entries = Object.entries(extracted)
    .filter(([path, data]) => !path.endsWith("/") && data)
    .map(([path, data]) => ({ path: normalizeZipPath(path), data: strFromU8(data) }));

  if (entries.length > maxFiles) {
    diagnostics.push({
      code: "ERR_IMPORT_FILE_TOO_LARGE",
      level: "error",
      message: `Archive has too many files (${entries.length} > ${maxFiles}).`,
      recoveryHint: "Remove node_modules/dist before zipping."
    });
    return { files: [], rootPrefix: "", diagnostics };
  }

  const rootPrefix = detectRootPrefix(entries.map((entry) => entry.path));
  const files = entries
    .map((entry) => ({
      path: stripPrefix(entry.path, rootPrefix),
      data: entry.data
    }))
    .filter((entry) => entry.path && !entry.path.startsWith("__MACOSX/"));

  return { files, rootPrefix, diagnostics };
}

export function exportProjectZip(input: ZipExportInput): Uint8Array {
  const root = (input.rootDirectory || "project").replace(/^\/+|\/+$/g, "");
  const payload: Record<string, Uint8Array> = {};
  for (const file of input.files) {
    const relative = file.path.replace(/^\/+/, "");
    payload[`${root}/${relative}`] = strToU8(file.data);
  }
  return zipSync(payload, { level: 6 });
}

function normalizeZipPath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "");
}

function detectRootPrefix(paths: string[]): string {
  if (paths.length === 0) return "";
  const firstSegments = paths.map((path) => path.split("/")[0] || "");
  const candidate = firstSegments[0];
  if (!candidate) return "";
  const allShare = firstSegments.every((segment) => segment === candidate);
  const hasNested = paths.some((path) => path.includes("/"));
  if (allShare && hasNested && paths.every((path) => path === candidate || path.startsWith(`${candidate}/`))) {
    return `${candidate}/`;
  }
  return "";
}

function stripPrefix(path: string, prefix: string): string {
  if (!prefix) return path;
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}
