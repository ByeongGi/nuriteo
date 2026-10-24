import { join } from "../../node-runtime/src/builtins/path.ts";
import { createAsyncCliModuleEvaluator } from "../../node-runtime/src/package-managers/cli-evaluator.ts";
import { containsNativeFallback } from "../../node-runtime/src/package-managers/native-fallback.ts";
import { parseShell } from "../../node-runtime/src/shell/parser.ts";
import type { ShellStep } from "../../node-runtime/src/shell/types.ts";
import type { RuntimeEnv } from "../../node-runtime/src/types.ts";

import type { ProductWorkflow } from "./controller-contracts.ts";

export interface WorkspacePackageScript {
  command: string;
  kind: "build" | "dev" | "process";
  name: string;
}

export interface WorkspacePackageScriptResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface WorkspacePackageLifecycleResult extends WorkspacePackageScriptResult {
  command: string;
  event: "preinstall" | "install" | "postinstall";
  packagePath: string;
}

export function readWorkspacePackageScript(
  workflow: ProductWorkflow,
  name: string
): WorkspacePackageScript {
  const manifest = JSON.parse(workflow.workspace.readText(join(workflow.projectRoot, "package.json"))) as {
    scripts?: Record<string, string>;
  };
  const command = manifest.scripts?.[name];
  if (!command) throw new Error(`missing package script: ${name}`);
  return { command, kind: classifyPackageScript(command), name };
}

export async function executeWorkspacePackageScript(
  workflow: ProductWorkflow,
  script: WorkspacePackageScript,
  forwardedArgs: readonly string[] = []
): Promise<WorkspacePackageScriptResult> {
  const steps = parseShell(script.command);
  appendForwardedArguments(steps, forwardedArgs);

  let stdout = "";
  let stderr = "";
  let stdin = "";
  let exitCode = 0;
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index]!;
    if (step.op === "&&" && exitCode !== 0) break;
    const nextStep = steps[index + 1];
    const command = parsePackageScriptCommand(step.argv, workflow.projectRoot);
    if (!command.entry) {
      return {
        stdout,
        stderr: `${stderr}unsupported package script command: ${step.argv.join(" ")}\n`,
        exitCode: 1
      };
    }

    const result = await executePackageScriptCommand(workflow, script.name, command, stdin);
    stderr += result.stderr;
    exitCode = result.exitCode;
    if (command.redirect) {
      workflow.workspace.writeText(command.redirect, result.stdout);
    } else if (nextStep?.op !== "|") {
      stdout += result.stdout;
    }
    stdin = nextStep?.op === "|" ? result.stdout : "";
    if (exitCode !== 0) break;
  }

  return { stdout, stderr, exitCode };
}

export async function executeWorkspaceNode(
  workflow: ProductWorkflow,
  cwd: string,
  args: readonly string[],
  stdin = ""
): Promise<WorkspacePackageScriptResult> {
  const command = parsePackageScriptCommand(["node", ...args], workflow.projectRoot, cwd);
  if (!command.entry) {
    return { stdout: "", stderr: "node: missing script path\n", exitCode: 1 };
  }
  return executePackageScriptCommand(workflow, "node", command, stdin, cwd);
}

export async function executeWorkspacePackageLifecycles(
  workflow: ProductWorkflow,
  packagePaths: readonly string[]
): Promise<WorkspacePackageLifecycleResult[]> {
  const results: WorkspacePackageLifecycleResult[] = [];
  for (const packagePath of packagePaths) {
    const manifest = JSON.parse(workflow.workspace.readText(join(packagePath, "package.json"))) as {
      scripts?: Record<string, string>;
    };
    for (const event of ["preinstall", "install", "postinstall"] as const) {
      const commandText = manifest.scripts?.[event];
      if (!commandText) continue;
      if (containsNativeFallback(commandText, "")) {
        results.push({
          command: commandText,
          event,
          packagePath,
          stdout: "",
          stderr: `native addon lifecycle is unsupported in the browser runtime: ${commandText}\n`,
          exitCode: 1
        });
        continue;
      }
      const steps = parseShell(commandText);
      let stdout = "";
      let stderr = "";
      let stdin = "";
      let exitCode = 0;
      for (let index = 0; index < steps.length; index += 1) {
        const step = steps[index]!;
        if (step.op === "&&" && exitCode !== 0) break;
        const nextStep = steps[index + 1];
        const command = parsePackageScriptCommand(
          step.argv,
          workflow.projectRoot,
          packagePath,
          (path) => workflow.workspace.exists(path)
        );
        const result = await executePackageScriptCommand(workflow, event, command, stdin, packagePath);
        stderr += result.stderr;
        exitCode = result.exitCode;
        if (command.redirect) workflow.workspace.writeText(command.redirect, result.stdout);
        else if (nextStep?.op !== "|") stdout += result.stdout;
        stdin = nextStep?.op === "|" ? result.stdout : "";
        if (exitCode !== 0) break;
      }
      results.push({ command: commandText, event, packagePath, stdout, stderr, exitCode });
    }
  }
  return results;
}

interface ParsedPackageScriptCommand {
  args: string[];
  entry: string | null;
  env: RuntimeEnv;
  redirect: string | null;
}

async function executePackageScriptCommand(
  workflow: ProductWorkflow,
  scriptName: string,
  command: ParsedPackageScriptCommand,
  stdin: string,
  cwd = workflow.projectRoot
): Promise<WorkspacePackageScriptResult> {
  if (!command.entry) {
    return { stdout: "", stderr: "unsupported package script command\n", exitCode: 1 };
  }

  let readOutput = () => ({ stdout: "", stderr: "" });
  const evaluator = createAsyncCliModuleEvaluator({
    onOutputSnapshot(snapshot) {
      readOutput = snapshot;
    },
    reader: workflow.workspace,
    writer: workflow.workspace,
    root: workflow.projectRoot,
    settleTicks: 4,
    settleTimeoutMs: 100
  });
  try {
    const result = await evaluator({
      entry: {
        entry: command.entry,
        name: scriptName,
        version: "workspace"
      },
      args: command.args,
      cwd,
      env: {
        PATH: `${cwd}/node_modules/.bin:${workflow.projectRoot}/node_modules/.bin:/bin`,
        PWD: cwd,
        INIT_CWD: workflow.projectRoot,
        npm_lifecycle_event: scriptName,
        ...command.env
      },
      ...(stdin ? { stdin } : {})
    });
    const output = readOutput();
    result.dispose?.();
    return {
      stdout: output.stdout || result.stdout,
      stderr: output.stderr || result.stderr,
      exitCode: result.exitCode
    };
  } catch (error) {
    return {
      stdout: readOutput().stdout,
      stderr: `${readOutput().stderr}${error instanceof Error ? error.message : String(error)}\n`,
      exitCode: 1
    };
  }
}

function classifyPackageScript(command: string): WorkspacePackageScript["kind"] {
  const steps = parseShell(command);
  const step = steps[0];
  if (steps.length !== 1 || !step || step.argv.includes(">")) return "process";
  const words = [...step.argv];
  const executableIndex = words.findIndex((word) => !isEnvironmentAssignment(word));
  const executable = words[executableIndex] || "";
  const args = words.slice(executableIndex + 1);
  if ((executable === "vite" && !args.includes("build")) || (executable === "next" && args[0] === "dev")) {
    return "dev";
  }
  if ((executable === "vite" && args.includes("build")) || (executable === "next" && args[0] === "build")) {
    return "build";
  }
  return "process";
}

function parsePackageScriptCommand(
  argv: readonly string[],
  projectRoot: string,
  cwd = projectRoot,
  exists: (path: string) => boolean = () => false
): ParsedPackageScriptCommand {
  const { args: commandArgs, redirect } = extractRedirect(argv, projectRoot, cwd);
  const words = [...commandArgs];
  const env: RuntimeEnv = {};
  while (words[0] && isEnvironmentAssignment(words[0])) {
    const assignment = words.shift()!;
    const separator = assignment.indexOf("=");
    env[assignment.slice(0, separator)] = assignment.slice(separator + 1);
  }

  const executable = words.shift();
  if (!executable) return { args: [], entry: null, env, redirect };
  if (executable === "node") {
    const entry = words.shift();
    return {
      args: words,
      entry: entry ? resolveProjectPath(entry, cwd, projectRoot, cwd) : null,
      env,
      redirect
    };
  }
  return {
    args: words,
    entry: resolveExecutable(executable, cwd, projectRoot, exists),
    env,
    redirect
  };
}

function extractRedirect(argv: readonly string[], projectRoot: string, cwd = projectRoot): {
  args: readonly string[];
  redirect: string | null;
} {
  const redirectIndex = argv.indexOf(">");
  if (redirectIndex < 0) return { args: argv, redirect: null };
  const target = argv[redirectIndex + 1];
  if (!target || redirectIndex + 2 !== argv.length) throw new Error("invalid stdout redirect");
  return {
    args: argv.slice(0, redirectIndex),
    redirect: resolveProjectPath(target, cwd, projectRoot, cwd)
  };
}

function appendForwardedArguments(steps: ShellStep[], forwardedArgs: readonly string[]): void {
  const args = stripArgumentSeparator(forwardedArgs);
  if (args.length === 0) return;
  const last = steps.at(-1);
  if (!last) return;
  const redirectIndex = last.argv.indexOf(">");
  if (redirectIndex < 0) last.argv.push(...args);
  else last.argv.splice(redirectIndex, 0, ...args);
}

function resolveProjectPath(path: string, binRoot: string, projectRoot: string, cwd = projectRoot): string {
  const resolved = path.startsWith("/")
    ? path
    : path.startsWith("./") || path.startsWith("../")
      ? join(cwd, path)
      : join(binRoot, path);
  if (resolved !== projectRoot && !resolved.startsWith(`${projectRoot}/`)) {
    throw new Error(`package script path escapes the project: ${path}`);
  }
  return resolved;
}

function resolveExecutable(
  executable: string,
  cwd: string,
  projectRoot: string,
  exists: (path: string) => boolean
): string {
  const local = resolveProjectPath(executable, `${cwd}/node_modules/.bin`, projectRoot, cwd);
  if (exists(local)) return local;
  return resolveProjectPath(executable, `${projectRoot}/node_modules/.bin`, projectRoot, cwd);
}

function isEnvironmentAssignment(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(value);
}

function stripArgumentSeparator(args: readonly string[]): string[] {
  return args[0] === "--" ? args.slice(1) : [...args];
}
