import type { ShellCommandMap, ShellCommandResult } from "../shell/index.ts";
import type { PackageManagerProcessResult } from "./types.ts";

export interface PackageManagerTerminalRunner {
  version(cwd?: string): PackageManagerProcessResult;
  install(cwd: string, args?: string[]): PackageManagerProcessResult;
  runScript(cwd: string, script: string, args?: string[]): PackageManagerProcessResult;
  exec(cwd: string, command: string, args?: string[]): PackageManagerProcessResult;
  ci?(cwd: string, args?: string[]): PackageManagerProcessResult;
}

export type PackageManagerTerminalCommandName = "npm" | "pnpm" | "yarn";

export interface PackageManagerTerminalCommandOptions {
  cwd?: string;
  npm?: PackageManagerTerminalRunner;
  pnpm?: PackageManagerTerminalRunner;
  yarn?: PackageManagerTerminalRunner;
  onResult?: (result: PackageManagerTerminalCommandResult) => void;
}

export interface PackageManagerTerminalCommandResult {
  name: PackageManagerTerminalCommandName;
  argv: string[];
  cwd: string;
  result: PackageManagerProcessResult;
}

export function createPackageManagerTerminalCommands(options: PackageManagerTerminalCommandOptions): ShellCommandMap {
  const commands: ShellCommandMap = {};
  if (options.npm) commands.npm = createPackageManagerTerminalCommand("npm", options.npm, options);
  if (options.pnpm) commands.pnpm = createPackageManagerTerminalCommand("pnpm", options.pnpm, options);
  if (options.yarn) commands.yarn = createPackageManagerTerminalCommand("yarn", options.yarn, options);
  return commands;
}

function createPackageManagerTerminalCommand(
  name: PackageManagerTerminalCommandName,
  runner: PackageManagerTerminalRunner,
  options: PackageManagerTerminalCommandOptions
) {
  return ({ argv, cwd, output, signal }: Parameters<NonNullable<ShellCommandMap[string]>>[0]): ShellCommandResult => {
    const commandCwd = options.cwd || cwd;
    if (signal?.aborted) return cancelledResult(argv);

    const result = runPackageManagerCommand(name, runner, commandCwd, argv.slice(1));
    options.onResult?.({ name, argv: [...argv], cwd: commandCwd, result });
    if (signal?.aborted) return cancelledResult(argv);
    if (result.stdout) output?.({ stream: "stdout", data: result.stdout });
    if (result.stderr) output?.({ stream: "stderr", data: result.stderr });

    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      argv: [...argv]
    };
  };
}

function runPackageManagerCommand(
  name: PackageManagerTerminalCommandName,
  runner: PackageManagerTerminalRunner,
  cwd: string,
  args: string[]
): PackageManagerProcessResult {
  const [command, second, ...rest] = args;
  if (name === "yarn" && !command) return runner.install(cwd);
  if (!command || command === "--version" || command === "-v" || command === "version") return runner.version(cwd);
  if (command === "install" || command === "i" || command === "add") return runner.install(cwd, args.slice(1));
  if (command === "ci") {
    if (runner.ci) return runner.ci(cwd, args.slice(1));
    return unsupportedPackageManagerResult(name, cwd, args, `${name}: ci is unsupported in this runtime\n`);
  }
  if (command === "run" || command === "run-script") {
    if (!second) return unsupportedPackageManagerResult(name, cwd, args, `${name}: missing script name\n`);
    return runner.runScript(cwd, second, rest);
  }
  if (command === "exec" || command === "x") {
    const execArgs = command === "exec" && second === "--" ? rest : args.slice(1);
    const [execCommand, ...execRest] = execArgs;
    if (!execCommand) return unsupportedPackageManagerResult(name, cwd, args, `${name}: missing exec command\n`);
    return runner.exec(cwd, execCommand, execRest);
  }
  if (name === "yarn" && command && !command.startsWith("-")) {
    return runner.runScript(cwd, command, args.slice(1));
  }
  return unsupportedPackageManagerResult(name, cwd, args, `${name}: unsupported terminal command: ${args.join(" ")}\n`);
}

function unsupportedPackageManagerResult(
  name: PackageManagerTerminalCommandName,
  cwd: string,
  args: string[],
  stderr: string
): PackageManagerProcessResult {
  return {
    stdout: "",
    stderr,
    exitCode: 1,
    entry: name,
    args,
    cwd,
    commandKind: "unknown"
  };
}

function cancelledResult(argv: string[]): ShellCommandResult {
  return {
    stdout: "",
    stderr: "cancelled\n",
    exitCode: 130,
    argv: [...argv]
  };
}
