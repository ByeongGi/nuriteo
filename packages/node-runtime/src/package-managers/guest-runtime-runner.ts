import type {
  GuestRuntimeProcessRunnerOptions,
  PackageManagerCommandKind,
  PackageManagerProcessRequest,
  PackageManagerProcessResult,
  PackageManagerProcessRunner
} from "./types.ts";
import { applyNpmInstallPlan, createNpmInstallPlan } from "./npm-install.ts";
import { applyPnpmStorePlan, createPnpmStorePlan } from "./pnpm-store.ts";
import { applyYarnInstallPlan, createYarnInstallPlan } from "./yarn-install.ts";
import { createCliModuleEvaluator } from "./cli-evaluator.ts";
import { createPackageScriptRunner, type PackageScriptReader } from "./script-runner.ts";

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
      if (options.cliModuleEvaluation) {
        const evaluated = createCliModuleEvaluator(options.cliModuleEvaluation)({
          entry: request.entry,
          args: request.args,
          cwd: request.cwd,
          env: request.env
        });
        return {
          ...baseResult(request),
          bootMode: "cli-module-evaluation",
          commandKind,
          stdout: evaluated.stdout,
          stderr: evaluated.stderr,
          exitCode: evaluated.exitCode
        };
      }
      return {
        ...baseResult(request),
        commandKind,
        stdout: `${request.entry.version}\n`,
        exitCode: 0,
      };
    }

    if ((commandKind === "install" || commandKind === "ci") && options.workspace) {
      return applyGuestInstallPlan(request, commandKind, options);
    }

    if ((commandKind === "run-script" || commandKind === "exec") && options.workspace) {
      return applyGuestScriptCommand(request, commandKind, options);
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

function applyGuestScriptCommand(
  request: PackageManagerProcessRequest,
  commandKind: "run-script" | "exec",
  options: GuestRuntimeProcessRunnerOptions
): PackageManagerProcessResult {
  if (!options.workspace) throw new Error("Guest script command requires a workspace");

  const runner = createPackageScriptRunner({
    cwd: request.cwd,
    env: request.env,
    reader: createPackageScriptReader(options.workspace.reader),
    writer: options.workspace.writer,
    ...(options.workspace.scriptPolicy ? { policy: options.workspace.scriptPolicy } : {})
  });
  const scriptResult = commandKind === "run-script"
    ? runner.runScript(parseRunScriptName(request.args))
    : runner.execBin(parseExecCommandName(request.args));

  return {
    ...baseResult(request),
    bootMode: "script-runner-application",
    commandKind,
    stdout: scriptResult.stdout,
    stderr: scriptResult.stderr,
    exitCode: scriptResult.exitCode
  };
}

function applyGuestInstallPlan(
  request: PackageManagerProcessRequest,
  commandKind: "install" | "ci",
  options: GuestRuntimeProcessRunnerOptions
): PackageManagerProcessResult {
  if (!options.workspace) throw new Error("Guest install plan requires a workspace");

  if (request.name === "npm") {
    const plan = createNpmInstallPlan({
      cwd: request.cwd,
      linkStrategy: options.workspace.linkStrategy || "copy-fallback",
      reader: options.workspace.reader
    });
    const applied = applyNpmInstallPlan(plan, options.workspace.writer);
    const lifecycle = shouldRunLifecycleScripts(request.args)
      ? runGuestPackageLifecycles(request, options, applied.links.map((link) => link.linkPath))
      : { stdout: "", stderr: "", exitCode: 0 };
    if (lifecycle.exitCode !== 0) {
      return {
        ...baseResult(request),
        bootMode: "install-plan-application",
        commandKind,
        stdout: lifecycle.stdout,
        stderr: lifecycle.stderr,
        exitCode: lifecycle.exitCode
      };
    }
    return {
      ...baseResult(request),
      bootMode: "install-plan-application",
      commandKind,
      exitCode: 0,
      stdout: `npm ${commandKind}: applied ${applied.links.length} local file links and ${applied.binLinks.length} bin links\n${lifecycle.stdout}`
    };
  }

  if (request.name === "yarn") {
    const plan = createYarnInstallPlan({
      cwd: request.cwd,
      linkStrategy: options.workspace.linkStrategy || "copy-fallback",
      reader: options.workspace.reader
    });
    const applied = applyYarnInstallPlan(plan, options.workspace.writer);
    const lifecycle = shouldRunLifecycleScripts(request.args)
      ? runGuestPackageLifecycles(request, options, applied.links.map((link) => link.linkPath))
      : { stdout: "", stderr: "", exitCode: 0 };
    return {
      ...baseResult(request),
      bootMode: "install-plan-application",
      commandKind,
      stdout: `yarn install: applied ${applied.links.length} local file links and ${applied.binLinks.length} bin links\n${lifecycle.stdout}`,
      stderr: lifecycle.stderr,
      exitCode: lifecycle.exitCode
    };
  }

  const plan = createPnpmStorePlan({
    cwd: request.cwd,
    linkStrategy: options.workspace.linkStrategy || "copy-fallback",
    reader: options.workspace.reader
  });
  const applied = applyPnpmStorePlan(plan, options.workspace.writer);
  const lifecycle = shouldRunLifecycleScripts(request.args)
    ? runGuestPackageLifecycles(request, options, applied.packageLinks.map((link) => link.linkPath))
    : { stdout: "", stderr: "", exitCode: 0 };
  if (lifecycle.exitCode !== 0) {
    return {
      ...baseResult(request),
      bootMode: "install-plan-application",
      commandKind,
      stdout: lifecycle.stdout,
      stderr: lifecycle.stderr,
      exitCode: lifecycle.exitCode
    };
  }
  return {
    ...baseResult(request),
    bootMode: "install-plan-application",
    commandKind,
    exitCode: 0,
    stdout: `pnpm install: applied ${applied.packageLinks.length} workspace links and ${applied.binLinks.length} bin links\n${lifecycle.stdout}`
  };
}

function runGuestPackageLifecycles(
  request: PackageManagerProcessRequest,
  options: GuestRuntimeProcessRunnerOptions,
  packagePaths: string[]
): Pick<PackageManagerProcessResult, "stdout" | "stderr" | "exitCode"> {
  if (!options.workspace) throw new Error("Guest package lifecycle requires a workspace");
  const runner = createPackageScriptRunner({
    cwd: request.cwd,
    env: request.env,
    reader: createPackageScriptReader(options.workspace.reader),
    writer: options.workspace.writer,
    ...(options.workspace.scriptPolicy ? { policy: options.workspace.scriptPolicy } : {})
  });
  let stdout = "";
  let stderr = "";
  for (const packagePath of packagePaths) {
    const result = runner.runLifecycle(packagePath, "install");
    stdout += result.stdout;
    stderr += result.stderr;
    if (result.exitCode !== 0) return { stdout, stderr, exitCode: result.exitCode };
  }
  return { stdout, stderr, exitCode: 0 };
}

function shouldRunLifecycleScripts(args: readonly string[]): boolean {
  return !args.includes("--ignore-scripts");
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

function createPackageScriptReader(reader: NonNullable<GuestRuntimeProcessRunnerOptions["workspace"]>["reader"]): PackageScriptReader {
  return {
    exists(path) {
      const maybeExists = reader as { exists?: (path: string) => boolean };
      if (maybeExists.exists) return maybeExists.exists(path);
      try {
        reader.readText(path);
        return true;
      } catch {
        return false;
      }
    },
    readText(path) {
      return reader.readText(path);
    }
  };
}

function parseRunScriptName(args: readonly string[]): string {
  const [command, script] = args;
  if ((command === "run" || command === "run-script") && script) return script;
  return "";
}

function parseExecCommandName(args: readonly string[]): string {
  const [, ...rest] = args;
  const execArgs = rest[0] === "--" ? rest.slice(1) : rest;
  return execArgs[0] || "";
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

function preflightCliEntry(name: "npm" | "pnpm" | "yarn", source: string): { ok: true } | { ok: false; reason: string } {
  if (!source.startsWith("#!/usr/bin/env node")) return { ok: false, reason: "missing node shebang" };
  if (name === "npm" && !source.includes("require('../lib/cli.js')(process)")) {
    return { ok: false, reason: "unexpected npm entrypoint shape" };
  }
  if (name === "pnpm" && !source.includes("require('../dist/pnpm.cjs')")) {
    return { ok: false, reason: "unexpected pnpm entrypoint shape" };
  }
  if (name === "yarn" && !source.includes("../lib/cli")) {
    return { ok: false, reason: "unexpected Yarn v1 entrypoint shape" };
  }
  return { ok: true };
}
