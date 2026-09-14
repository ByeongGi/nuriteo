import { createBuiltinLoader } from "../builtin-loader.ts";
import { BrowserProcess } from "../builtins/process.ts";
import { createWorkspaceModuleRuntime, type WorkspaceModuleReader } from "../modules/index.ts";
import type { CliEntry, CliRunResult, RuntimeEnv } from "../types.ts";

export interface CliModuleEvaluatorOptions {
  reader: WorkspaceModuleReader;
  root?: string;
}

export interface CliModuleEvaluationRequest {
  entry: CliEntry;
  args: string[];
  cwd: string;
  env?: RuntimeEnv;
}

export function createCliModuleEvaluator(options: CliModuleEvaluatorOptions): (request: CliModuleEvaluationRequest) => CliRunResult {
  return function evaluateCliModule(request: CliModuleEvaluationRequest): CliRunResult {
    let stdout = "";
    let stderr = "";
    const processOptions = {
      argv: ["node", request.entry.entry, ...request.args],
      cwd: request.cwd,
      ...(request.env ? { env: request.env } : {})
    };
    const process = new BrowserProcess(processOptions);
    process.on("stdout", (chunk) => {
      stdout += String(chunk);
    });
    process.on("stderr", (chunk) => {
      stderr += String(chunk);
    });

    const runtime = createWorkspaceModuleRuntime({
      root: options.root || "/workspace",
      reader: options.reader,
      builtins: createBuiltinLoader({ process }),
      globals: { process }
    });

    let exitCode = 0;
    try {
      runtime.requireSync(request.entry.entry, request.entry.entry);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const exit = parseProcessExit(message);
      if (exit !== null) {
        exitCode = exit;
      } else {
        exitCode = 1;
        stderr += `${message}\n`;
      }
    }
    if (process.exitCode !== undefined) exitCode = process.exitCode;

    return {
      stdout,
      stderr,
      exitCode,
      entry: request.entry.entry,
      ...(request.entry.entrySha256 ? { entrySha256: request.entry.entrySha256 } : {})
    };
  };
}

function parseProcessExit(message: string): number | null {
  const match = message.match(/^process\.exit\((\d+)\)$/);
  return match ? Number(match[1]) : null;
}
