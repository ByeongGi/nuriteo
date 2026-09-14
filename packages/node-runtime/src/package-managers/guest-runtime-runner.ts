import type {
  GuestRuntimeProcessRunnerOptions,
  PackageManagerProcessRequest,
  PackageManagerProcessResult,
  PackageManagerProcessRunner
} from "./types.ts";

export function createGuestRuntimeProcessRunner(options: GuestRuntimeProcessRunnerOptions): PackageManagerProcessRunner {
  if (!options?.artifacts) throw new Error("Guest runtime process runner requires CLI artifacts");

  return function runGuestRuntimeProcess(request: PackageManagerProcessRequest): PackageManagerProcessResult {
    const entrySource = options.artifacts.readText(request.entry.entry);
    const preflight = preflightCliEntry(request.name, entrySource);
    if (!preflight.ok) {
      return {
        ...baseResult(request),
        stderr: `${request.name}: unsupported guest CLI entry: ${preflight.reason}\n`,
        exitCode: 1
      };
    }

    if (request.args.length === 1 && request.args[0] === "--version") {
      return {
        ...baseResult(request),
        stdout: `${request.entry.version}\n`,
        exitCode: 0,
      };
    }

    return {
      ...baseResult(request),
      stderr: `${request.name}: guest runtime argument path is not implemented yet: ${request.args.join(" ")}\n`,
      exitCode: 1
    };
  };
}

function baseResult(request: PackageManagerProcessRequest): PackageManagerProcessResult {
  const result: PackageManagerProcessResult = {
    stdout: "",
    stderr: "",
    exitCode: 1,
    entry: request.entry.entry,
    args: request.args,
    cwd: request.cwd,
    runtime: "browser-guest-node-runtime",
    bootMode: "artifact-entry-preflight"
  };
  if (request.entry.entrySha256 !== undefined) result.entrySha256 = request.entry.entrySha256;
  return result;
}

function preflightCliEntry(name: "npm" | "pnpm", source: string): { ok: true } | { ok: false; reason: string } {
  if (!source.startsWith("#!/usr/bin/env node")) return { ok: false, reason: "missing node shebang" };
  if (name === "npm" && !source.includes("require('../lib/cli.js')(process)")) {
    return { ok: false, reason: "unexpected npm entrypoint shape" };
  }
  if (name === "pnpm" && !source.includes("require")) {
    return { ok: false, reason: "unexpected pnpm entrypoint shape" };
  }
  return { ok: true };
}
