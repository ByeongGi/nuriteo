import { join, normalize } from "../builtins/path.ts";
import type { ShellCommandMap, ShellCommandResult } from "../shell/types.ts";

export interface JqRuntime {
  json(input: unknown, filter: string): unknown;
}

export interface JqProjectAdapterOptions {
  projectRoot: string;
  readText(path: string): string;
  writeText?(path: string, data: string): void;
  loadRuntime(): Promise<JqRuntime>;
  maxInputBytes?: number;
  maxOutputBytes?: number;
}

export interface JqTransformResult {
  inputPath: string;
  outputPath: string | null;
  output: string;
}

export class JqProjectAdapter {
  readonly projectRoot: string;
  readonly maxInputBytes: number;
  readonly maxOutputBytes: number;
  #options: JqProjectAdapterOptions;
  #runtime: Promise<JqRuntime> | null = null;

  constructor(options: JqProjectAdapterOptions) {
    this.projectRoot = normalize(options.projectRoot);
    this.maxInputBytes = options.maxInputBytes ?? 2 * 1024 * 1024;
    this.maxOutputBytes = options.maxOutputBytes ?? 2 * 1024 * 1024;
    this.#options = options;
  }

  async transformFile(filter: string, inputPath: string, outputPath?: string): Promise<JqTransformResult> {
    if (!filter.trim()) throw toolingError("EJQFILTER", "jq filter must not be empty");
    const resolvedInput = this.#resolve(inputPath);
    const source = this.#options.readText(resolvedInput);
    if (byteLength(source) > this.maxInputBytes) {
      throw toolingError("EJQINPUTLIMIT", `jq input exceeds ${this.maxInputBytes} bytes`);
    }
    let input: unknown;
    try {
      input = JSON.parse(source);
    } catch {
      throw toolingError("EJQJSON", `jq input is not valid JSON: ${inputPath}`);
    }
    const runtime = await (this.#runtime ??= this.#options.loadRuntime());
    const output = `${JSON.stringify(runtime.json(input, filter), null, 2)}\n`;
    if (byteLength(output) > this.maxOutputBytes) {
      throw toolingError("EJQOUTPUTLIMIT", `jq output exceeds ${this.maxOutputBytes} bytes`);
    }
    const resolvedOutput = outputPath ? this.#resolve(outputPath) : null;
    if (resolvedOutput) {
      if (!this.#options.writeText) throw toolingError("EJQREADONLY", "jq output writes are disabled");
      this.#options.writeText(resolvedOutput, output);
    }
    return { inputPath: resolvedInput, outputPath: resolvedOutput, output };
  }

  #resolve(path: string): string {
    const resolved = normalize(path.startsWith("/") ? path : join(this.projectRoot, path));
    if (resolved !== this.projectRoot && !resolved.startsWith(`${this.projectRoot}/`)) {
      throw toolingError("EJQPROJECTPATH", `jq path is outside the project: ${path}`);
    }
    return resolved;
  }
}

export function createJqProjectAdapter(options: JqProjectAdapterOptions): JqProjectAdapter {
  return new JqProjectAdapter(options);
}

export function createJqShellCommands(adapter: JqProjectAdapter): ShellCommandMap {
  return {
    jq: async ({ argv }): Promise<ShellCommandResult> => {
      const [filter, input, output] = argv.slice(1);
      if (!filter || !input) {
        return result(argv, 2, "", "usage: jq <filter> <project-json-path> [output-path]\n");
      }
      try {
        const transformed = await adapter.transformFile(filter, input, output);
        return result(argv, 0, output ? `wrote ${transformed.outputPath}\n` : transformed.output, "");
      } catch (error) {
        const value = error as Error & { code?: string };
        return result(argv, 1, "", `${value.code || "EJQ"}: ${value.message}\n`);
      }
    }
  };
}

function result(argv: string[], exitCode: number, stdout: string, stderr: string): ShellCommandResult {
  return { argv: [...argv], exitCode, stdout, stderr };
}

function toolingError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
