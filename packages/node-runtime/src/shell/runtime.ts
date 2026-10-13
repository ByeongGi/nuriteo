import { createCommandRegistry, shebangCommand } from "./commands.ts";
import { parseShell } from "./parser.ts";
import type { RuntimeEnv } from "../types.ts";
import type { ShellCommand, ShellCommandRegistry, ShellRunOptions, ShellRunResult, ShellRuntimeOptions } from "./types.ts";

export class ShellRuntime {
  cwd: string;
  env: RuntimeEnv;
  files: Map<string, string>;
  registry: ShellCommandRegistry;
  maxOutputBytes: number;

  constructor(options: ShellRuntimeOptions = {}) {
    this.cwd = options.cwd || "/workspace";
    this.env = { PATH: "/workspace/node_modules/.bin:/bin", ...(options.env || {}) };
    this.files = new Map(Object.entries(options.files || {}));
    this.registry = createCommandRegistry(options.commands || {});
    this.maxOutputBytes = positiveLimit(options.maxOutputBytes, 1024 * 1024, "maxOutputBytes");
  }

  async run(commandLine: string, options: ShellRunOptions = {}): Promise<ShellRunResult> {
    const steps = parseShell(commandLine);
    let stdin = "";
    let stdout = "";
    let stderr = "";
    let exitCode = 0;
    let outputTruncatedBytes = 0;

    for (let index = 0; index < steps.length; index += 1) {
      if (options.signal?.aborted) return cancelledShellResult(stdout, stderr, this.files, options.signal.reason);
      const step = steps[index];
      if (!step) continue;
      const nextStep = steps[index + 1];
      if (step.op === "&&" && exitCode !== 0) break;
      const { argv, redirect } = extractRedirect(step.argv);
      const streamed = { stderr: false, stdout: false };
      const result = await this.runCommand(argv, stdin, commandOutputOptions(options, streamed, nextStep?.op === "|"));
      outputTruncatedBytes += result.outputTruncatedBytes || 0;
      if (options.signal?.aborted) {
        const cancelledStdout = appendWithinLimit(stdout, result.stdout || "", this.maxOutputBytes - byteLength(stderr));
        const cancelledStderr = appendWithinLimit(stderr, result.stderr || "", this.maxOutputBytes - byteLength(cancelledStdout.value));
        const cancelled = cancelledShellResult(cancelledStdout.value, cancelledStderr.value, this.files, options.signal.reason);
        const boundedCancelledStderr = appendWithinLimit("", cancelled.stderr, this.maxOutputBytes - byteLength(cancelled.stdout));
        const dropped = outputTruncatedBytes + cancelledStdout.droppedBytes + cancelledStderr.droppedBytes + boundedCancelledStderr.droppedBytes;
        const boundedCancelled = { ...cancelled, stderr: boundedCancelledStderr.value };
        return dropped > 0 ? { ...boundedCancelled, outputTruncatedBytes: dropped } : boundedCancelled;
      }
      exitCode = result.exitCode;
      const appendedStderr = appendWithinLimit(stderr, result.stderr || "", this.maxOutputBytes - byteLength(stdout));
      stderr = appendedStderr.value;
      outputTruncatedBytes += appendedStderr.droppedBytes;
      if (result.stderr && !streamed.stderr) options.onOutput?.({ stream: "stderr", data: result.stderr });
      if (redirect) {
        const redirected = appendWithinLimit("", result.stdout || "", this.maxOutputBytes);
        this.files.set(resolvePath(redirect, this.cwd), redirected.value);
        outputTruncatedBytes += redirected.droppedBytes;
      }
      else if (nextStep?.op !== "|") {
        const appendedStdout = appendWithinLimit(stdout, result.stdout || "", this.maxOutputBytes - byteLength(stderr));
        stdout = appendedStdout.value;
        outputTruncatedBytes += appendedStdout.droppedBytes;
        if (result.stdout && !streamed.stdout) options.onOutput?.({ stream: "stdout", data: result.stdout });
      }
      if (nextStep?.op === "|") {
        const piped = appendWithinLimit("", result.stdout || "", this.maxOutputBytes);
        stdin = piped.value;
        outputTruncatedBytes += piped.droppedBytes;
      } else {
        stdin = "";
      }
      if (exitCode !== 0) break;
    }

    return {
      stdout,
      stderr,
      exitCode,
      files: Object.fromEntries(this.files),
      ...(outputTruncatedBytes > 0 ? { outputTruncatedBytes } : {})
    };
  }

  async runCommand(argv: string[], stdin: string, options: ShellRunOptions = {}): Promise<Awaited<ReturnType<ShellCommand>>> {
    if (argv[0] === "sh" && argv[1] === "-c") {
      return this.run(argv.slice(2).join(" "), nestedShellOptions(options));
    }

    const name = argv[0];
    if (!name) throw new Error("missing command");
    const builtin = this.runStatefulBuiltin(argv);
    if (builtin) return builtin;
    const command = this.resolveExecutable(name);
    const context = {
      argv,
      cwd: this.cwd,
      env: this.env,
      stdin,
      files: this.files
    };
    return command({
      ...context,
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.onOutput ? { output: options.onOutput } : {}),
      ...(options.terminal ? { terminal: options.terminal } : {})
    });
  }

  runStatefulBuiltin(argv: string[]): Awaited<ReturnType<ShellCommand>> | null {
    if (argv[0] === "cd") {
      const target = normalizePath(argv[1] || this.env.HOME || "/workspace", this.cwd);
      this.cwd = target;
      this.env.PWD = target;
      return { stdout: "", stderr: "", exitCode: 0, argv };
    }
    if (argv[0] === "export") {
      for (const assignment of argv.slice(1)) {
        const index = assignment.indexOf("=");
        if (index <= 0) return { stdout: "", stderr: `export: invalid assignment: ${assignment}\n`, exitCode: 2, argv };
        this.env[assignment.slice(0, index)] = assignment.slice(index + 1);
      }
      return { stdout: "", stderr: "", exitCode: 0, argv };
    }
    if (argv[0] === "unset") {
      for (const name of argv.slice(1)) delete this.env[name];
      return { stdout: "", stderr: "", exitCode: 0, argv };
    }
    return null;
  }

  resolveExecutable(name: string): ShellCommand {
    const filePath = this.resolveFileExecutable(name);
    if (filePath) {
      const source = this.files.get(filePath);
      if (source === undefined) throw new Error(`missing executable source: ${filePath}`);
      const shebang = shebangCommand(source);
      if (isNodeShebang(shebang)) {
        return ({ argv }) => ({
          stdout: source.includes("console.log")
            ? `${source.match(/console\.log\(["']([^"']+)["']\)/)?.[1] || ""}\n`
            : "",
          stderr: "",
          exitCode: 0,
          argv
        });
      }
    }
    return this.registry.resolve(name, this.env, this.cwd);
  }

  resolveFileExecutable(name: string): string | null {
    const direct = resolvePath(name, this.cwd);
    if (this.files.has(direct)) return direct;
    for (const dir of (this.env.PATH || "").split(":").filter(Boolean)) {
      const candidate = dir.startsWith("/") ? `${dir}/${name}` : `${this.cwd}/${dir}/${name}`;
      if (this.files.has(candidate)) return candidate;
    }
    return null;
  }
}

function isNodeShebang(shebang: string[] | null): boolean {
  if (!shebang) return false;
  if (shebang[0]?.endsWith("node")) return true;
  return Boolean(shebang[0]?.endsWith("env") && shebang[1] === "node");
}

export function createShellRuntime(options: ShellRuntimeOptions = {}): ShellRuntime {
  return new ShellRuntime(options);
}

function cancelledShellResult(stdout: string, stderr: string, files: Map<string, string>, reason?: unknown): ShellRunResult {
  const signal = reason === "SIGTERM" || reason === "SIGKILL" ? reason : "SIGINT";
  return {
    stdout,
    stderr: stderr || `${signal.toLowerCase()}\n`,
    exitCode: signal === "SIGTERM" ? 143 : signal === "SIGKILL" ? 137 : 130,
    files: Object.fromEntries(files)
  };
}

function appendWithinLimit(current: string, next: string, maxBytes: number): { value: string; droppedBytes: number } {
  const available = Math.max(0, maxBytes - byteLength(current));
  const encoded = new TextEncoder().encode(next);
  if (encoded.byteLength <= available) return { value: current + next, droppedBytes: 0 };
  const retained = new TextDecoder().decode(encoded.slice(0, available));
  return { value: current + retained, droppedBytes: encoded.byteLength - byteLength(retained) };
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function positiveLimit(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1) throw new RangeError(`${name} must be a positive safe integer`);
  return resolved;
}

function nestedShellOptions(options: ShellRunOptions): ShellRunOptions {
  const nested: ShellRunOptions = {};
  if (options.signal) nested.signal = options.signal;
  if (options.onOutput) nested.onOutput = options.onOutput;
  if (options.terminal) nested.terminal = options.terminal;
  return nested;
}

function normalizePath(path: string, cwd: string): string {
  const parts = (path.startsWith("/") ? path : `${cwd}/${path}`).split("/");
  const normalized: string[] = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") normalized.pop();
    else normalized.push(part);
  }
  return `/${normalized.join("/")}`;
}

function commandOutputOptions(
  options: ShellRunOptions,
  streamed: { stderr: boolean; stdout: boolean },
  pipedStdout: boolean
): ShellRunOptions {
  if (!options.onOutput) return options;
  return {
    ...options,
    onOutput(chunk) {
      streamed[chunk.stream] = true;
      if (pipedStdout && chunk.stream === "stdout") return;
      options.onOutput?.(chunk);
    }
  };
}

function extractRedirect(argv: string[]): { argv: string[]; redirect: string | null } {
  const index = argv.indexOf(">");
  if (index < 0) return { argv, redirect: null };
  const redirect = argv[index + 1];
  if (!redirect) throw new Error("missing redirect target");
  return {
    argv: argv.slice(0, index),
    redirect
  };
}

function resolvePath(path: string, cwd: string): string {
  return path.startsWith("/") ? path : `${cwd}/${path}`;
}
