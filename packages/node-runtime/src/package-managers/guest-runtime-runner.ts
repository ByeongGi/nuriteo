import type {
  GuestRuntimeProcessRunnerOptions,
  PackageManagerCommandKind,
  PackageManagerProcessRequest,
  PackageManagerProcessResult,
  PackageManagerProcessRunner
} from "./types.ts";

export function createGuestRuntimeProcessRunner(options: GuestRuntimeProcessRunnerOptions): PackageManagerProcessRunner {
  if (!options?.artifacts) throw new Error("Guest runtime process runner requires CLI artifacts");

  return function runGuestRuntimeProcess(request: PackageManagerProcessRequest): PackageManagerProcessResult {
    const entrySource = options.artifacts.readText(request.entry.entry);
    const commandKind = classifyPackageManagerCommand(request.args);
    const preflight = preflightCliEntry(request.name, entrySource);
    if (!preflight.ok) {
      return {
        ...baseResult(request),
        commandKind,
        stderr: `${request.name}: unsupported guest CLI entry: ${preflight.reason}\n`,
        exitCode: 1,
        error: {
          code: "ERR_PM_CLI_ENTRY_UNSUPPORTED",
          message: preflight.reason
        }
      };
    }

    if (commandKind === "version") {
      return {
        ...baseResult(request),
        commandKind,
        stdout: `${request.entry.version}\n`,
        exitCode: 0,
      };
    }

    const message = `${request.name}: real CLI evaluation is required for ${request.args.join(" ") || "<empty>"}`;
    return {
      ...baseResult(request),
      bootMode: "blocked-real-cli-evaluation",
      commandKind,
      stderr: `${message}\n`,
      exitCode: 1,
      error: {
        code: "ERR_PM_REAL_CLI_EVALUATION_REQUIRED",
        message,
        nextAction: "Evaluate the vendored CLI module graph inside the browser guest runtime instead of using the host-node-test-helper."
      }
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

export function classifyPackageManagerCommand(args: readonly string[]): PackageManagerCommandKind {
  const [command, second] = args;
  if (args.length === 1 && (command === "--version" || command === "-v" || command === "version")) return "version";
  if (command === "install" || command === "i" || command === "add") return "install";
  if (command === "ci") return "ci";
  if (command === "run" || command === "run-script") return "run-script";
  if (command === "exec" || (command === "x" && second !== undefined)) return "exec";
  return "unknown";
}

function preflightCliEntry(name: "npm" | "pnpm", source: string): { ok: true } | { ok: false; reason: string } {
  if (!source.startsWith("#!/usr/bin/env node")) return { ok: false, reason: "missing node shebang" };
  if (name === "npm" && !source.includes("require('../lib/cli.js')(process)")) {
    return { ok: false, reason: "unexpected npm entrypoint shape" };
  }
  if (name === "pnpm" && !source.includes("require('../dist/pnpm.cjs')")) {
    return { ok: false, reason: "unexpected pnpm entrypoint shape" };
  }
  return { ok: true };
}
