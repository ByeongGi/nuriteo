import { normalize } from "../builtins/path.ts";

export type WasiBoundaryErrorCode = "EWASIPATH" | "EWASIENV" | "EWASINETWORK" | "EWASISTDIO";
export type WasiFilesystemAccess = "read" | "write";
export type WasiNetworkKind = "tcp" | "udp" | "fetch";

export interface WasiRuntimeBoundaryOptions {
  projectRoot?: string;
  readableRoots?: string[];
  writableRoots?: string[];
  allowedEnv?: string[];
  allowedEnvPrefixes?: string[];
  allowClock?: boolean;
  allowRandom?: boolean;
  allowFetch?: boolean;
  stdioCapacity?: number;
}

export interface WasiRuntimeBoundary {
  projectRoot: string;
  readableRoots: string[];
  writableRoots: string[];
  allowedEnv: string[];
  allowedEnvPrefixes: string[];
  allowClock: boolean;
  allowRandom: boolean;
  allowFetch: boolean;
  stdioCapacity: number;
}

export interface WasiStdioLimits {
  stdinBytes: number;
  stdoutBytes: number;
  stderrBytes: number;
}

export class WasiBoundaryError extends Error {
  code: WasiBoundaryErrorCode;

  constructor(message: string, code: WasiBoundaryErrorCode) {
    super(message);
    this.name = "WasiBoundaryError";
    this.code = code;
  }
}

export function createWasiRuntimeBoundary(options: WasiRuntimeBoundaryOptions = {}): WasiRuntimeBoundary {
  const projectRoot = normalizeAbsolute(options.projectRoot || "/workspace");
  return {
    projectRoot,
    readableRoots: normalizeRoots(options.readableRoots || [projectRoot]),
    writableRoots: normalizeRoots(options.writableRoots || [projectRoot]),
    allowedEnv: [...(options.allowedEnv || ["NODE_ENV", "CI"])],
    allowedEnvPrefixes: [...(options.allowedEnvPrefixes || ["npm_", "VITE_"])],
    allowClock: options.allowClock ?? true,
    allowRandom: options.allowRandom ?? true,
    allowFetch: options.allowFetch ?? false,
    stdioCapacity: options.stdioCapacity ?? 1024 * 1024
  };
}

export function validateWasiFilesystemAccess(
  boundary: WasiRuntimeBoundary,
  filePath: string,
  access: WasiFilesystemAccess
): string {
  const normalized = normalizeAbsolute(filePath);
  const roots = access === "read" ? boundary.readableRoots : boundary.writableRoots;
  if (!roots.some((root) => isWithinRoot(normalized, root))) {
    throw new WasiBoundaryError(`WASI ${access} outside project sandbox: ${filePath}`, "EWASIPATH");
  }
  return normalized;
}

export function filterWasiEnv(boundary: WasiRuntimeBoundary, env: Record<string, string>): Record<string, string> {
  const allowed = new Set(boundary.allowedEnv);
  return Object.fromEntries(
    Object.entries(env).filter(([key]) => allowed.has(key) || boundary.allowedEnvPrefixes.some((prefix) => key.startsWith(prefix)))
  );
}

export function validateWasiEnv(boundary: WasiRuntimeBoundary, env: Record<string, string>): Record<string, string> {
  const filtered = filterWasiEnv(boundary, env);
  const rejected = Object.keys(env).filter((key) => !(key in filtered));
  if (rejected.length > 0) {
    throw new WasiBoundaryError(`WASI environment contains denied keys: ${rejected.join(", ")}`, "EWASIENV");
  }
  return filtered;
}

export function validateWasiNetwork(boundary: WasiRuntimeBoundary, kind: WasiNetworkKind): void {
  if (kind === "tcp" || kind === "udp") {
    throw new WasiBoundaryError(`WASI direct ${kind.toUpperCase()} sockets are unsupported in the browser runtime`, "EWASINETWORK");
  }
  if (kind === "fetch" && !boundary.allowFetch) {
    throw new WasiBoundaryError("WASI fetch requires an explicit host fetch adapter", "EWASINETWORK");
  }
}

export function createWasiStdioLimits(boundary: WasiRuntimeBoundary): WasiStdioLimits {
  if (!Number.isSafeInteger(boundary.stdioCapacity) || boundary.stdioCapacity <= 0) {
    throw new WasiBoundaryError(`invalid WASI stdio capacity: ${boundary.stdioCapacity}`, "EWASISTDIO");
  }
  return {
    stdinBytes: boundary.stdioCapacity,
    stdoutBytes: boundary.stdioCapacity,
    stderrBytes: boundary.stdioCapacity
  };
}

function normalizeRoots(roots: string[]): string[] {
  return [...new Set(roots.map(normalizeAbsolute))];
}

function normalizeAbsolute(value: string): string {
  if (!value.startsWith("/")) throw new WasiBoundaryError(`WASI path must be absolute: ${value}`, "EWASIPATH");
  return normalize(value);
}

function isWithinRoot(filePath: string, root: string): boolean {
  return filePath === root || filePath.startsWith(`${root}/`);
}
