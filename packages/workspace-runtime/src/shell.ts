import {
  createTerminalSession,
  type TerminalRunResult,
  type TerminalSession
} from "../../node-runtime/src/shell/index.ts";
import type { ProjectWorkspaceStore } from "../../browser-host/src/storage/index.ts";
import type {
  ShellCommandContext,
  ShellCommandMap,
  ShellCommandResult,
  ShellRuntimeOptions
} from "../../node-runtime/src/shell/types.ts";

export interface PreviewShellHandlers {
  getCwd: () => string;
  getProject: () => ProjectWorkspaceStore | null;
  install: (request?: PreviewPackageInstallRequest) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
  runNode?: (cwd: string, args: string[], stdin?: string) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
  runScript: (name: string, args?: string[]) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
  restartDev: (args?: string[]) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
  onChunk?: (chunk: { stream: "stdout" | "stderr"; data: string }) => void;
  processCommands?: ShellCommandMap;
}

export interface PreviewPackageInstallRequest {
  ignoreScripts: boolean;
  manager: "npm" | "pnpm" | "yarn";
  packages: string[];
  save: "dependencies" | "devDependencies" | false;
  signal?: AbortSignal;
}

export interface PreviewShellSession {
  run(command: string): Promise<TerminalRunResult>;
  cancel(): boolean;
  session: TerminalSession;
}

const HELP = [
  "NURITEO shell",
  "",
  "Built-ins:",
  "  help                 Show this help",
  "  clear                Clear the terminal UI",
  "  pwd                  Print working directory",
  "  ls [-la] [path]      List project files",
  "  cat <path...>        Print project files or piped input",
  "  head [-n count] path Print first lines (default 10)",
  "  wc [path]            Line/word/byte counts",
  "  grep [-in] text ...  Search files or piped input",
  "  find [path] [-name]  Find project files",
  "  mkdir [-p] <path>    Create folder marker (.gitkeep)",
  "  touch <path>         Create empty file",
  "  rm [-r] <path>       Delete project files or folders",
  "  cp <from> <to>       Copy a project file",
  "  mv <from> <to>       Rename/move a project file",
  "  echo <text>          Print text",
  "  printf <format> ...  Print formatted text",
  "  env | whoami | uname Inspect the virtual environment",
  "  node <file> [args...] Run a Node.js program in this project",
  "",
  "Worker processes (browser virtual process):",
  "  worker-cat           Echo stdin until interrupted",
  "  worker-pty           Canonical PTY-like input with echo/control keys",
  "  worker-pwd           Print the Worker process cwd",
  "  worker-env           Print the Worker process environment",
  "  worker-tty [--watch] Print or watch the Worker TTY size",
  "",
  "Package scripts (wired to preview workflow):",
  "  npm install | pnpm install | yarn install",
  "  npm run dev | pnpm run dev | yarn dev",
  "  npm run build | pnpm run build | yarn build",
  "  npm run start        Alias for run preview",
  "  npm/pnpm/yarn run <name> -- <args> forwards arbitrary script arguments",
  ""
].join("\n");

export function createPreviewShellSession(handlers: PreviewShellHandlers): PreviewShellSession {
  const commands: ShellCommandMap = {
    help: ({ argv }) => ok(argv, `${HELP}\n`),
    clear: ({ argv }) => ok(argv, "\x1b[2J\x1b[H"),
    pwd: ({ argv, cwd }) => ok(argv, `${cwd}\n`),
    echo: ({ argv }) => ok(argv, `${argv.slice(1).join(" ")}\n`),
    printf: ({ argv }) => ok(argv, formatPrintf(argv.slice(1))),
    env: ({ argv, env }) => ok(argv, formatEnvironment(env)),
    whoami: ({ argv }) => ok(argv, "webcontainer\n"),
    uname: ({ argv }) => ok(argv, argv.includes("-a")
      ? "Linux webcontainer 5.0.0 nuriteo wasm x86_64 GNU/Linux\n"
      : "Linux\n"),
    ls: (context) => listFiles(handlers, context),
    cat: (context) => readFile(handlers, context),
    head: (context) => headFile(handlers, context),
    wc: (context) => wordCount(handlers, context),
    grep: (context) => grepFiles(handlers, context),
    find: (context) => findFiles(handlers, context),
    mkdir: (context) => mkdirPath(handlers, context),
    touch: (context) => touchFile(handlers, context),
    rm: (context) => removeFile(handlers, context),
    cp: (context) => copyFile(handlers, context),
    mv: (context) => moveFile(handlers, context),
    node: (context) => runNode(handlers, context),
    npm: (context) => runPackageManager(handlers, "npm", context),
    pnpm: (context) => runPackageManager(handlers, "pnpm", context),
    yarn: (context) => runPackageManager(handlers, "yarn", context),
    ...(handlers.processCommands || {})
  };

  let cwd = handlers.getCwd();
  let session = createTerminalSession({
    cwd,
    commands,
    ...projectFiles(handlers),
    onChunk(chunk) {
      handlers.onChunk?.({ stream: chunk.stream, data: chunk.data });
    }
  });

  function ensureSession(): TerminalSession {
    const nextCwd = handlers.getCwd();
    if (nextCwd !== cwd && !session.activeEntry) {
      cwd = nextCwd;
      session = createTerminalSession({
        cwd,
        commands,
        ...projectFiles(handlers),
        onChunk(chunk) {
          handlers.onChunk?.({ stream: chunk.stream, data: chunk.data });
        }
      });
    }
    return session;
  }

  return {
    get session() {
      return ensureSession();
    },
    cancel: () => session.cancel(),
    async run(command: string) {
      return ensureSession().run(command);
    }
  };
}

async function runNode(
  handlers: PreviewShellHandlers,
  context: ShellCommandContext
): Promise<ShellCommandResult> {
  const { argv, cwd, stdin, signal } = context;
  if (!argv[1]) return fail(argv, "node: missing script path\n");
  if (!handlers.runNode) return fail(argv, "node: runtime unavailable\n");
  return toResult(argv, await abortable(handlers.runNode(cwd, argv.slice(1), stdin), signal));
}

async function runPackageManager(
  handlers: PreviewShellHandlers,
  manager: "npm" | "pnpm" | "yarn",
  context: ShellCommandContext
): Promise<ShellCommandResult> {
  const { argv, signal } = context;
  const args = argv.slice(1);
  const [command, script, ...rest] = args;

  if (!command && manager === "yarn") return toResult(argv, await abortable(handlers.install(), signal));
  if (!command || command === "--version" || command === "-v" || command === "version") {
    return ok(argv, `${manager} (nuriteo preview shell)\n`);
  }

  if (command === "install" || command === "i" || command === "add") {
    const packages = args.slice(1).filter((value) => !value.startsWith("-"));
    const save = args.includes("--no-save")
      ? false
      : args.includes("--save-dev") || args.includes("-D") || args.includes("--dev")
        ? "devDependencies" as const
        : "dependencies" as const;
    return toResult(argv, await abortable(handlers.install({
      ignoreScripts: args.includes("--ignore-scripts"),
      manager,
      packages,
      save,
      ...(signal ? { signal } : {})
    }), signal));
  }

  if (command === "run" || command === "run-script") {
    if (!script) return fail(argv, `${manager}: missing script name\n`);
    if (script === "restart") return toResult(argv, await abortable(handlers.restartDev(rest), signal));
    return toResult(argv, await abortable(handlers.runScript(script, rest), signal));
  }

  if (command === "start") {
    return toResult(argv, await abortable(handlers.runScript("start"), signal));
  }

  if ((manager === "pnpm" || manager === "yarn") && command && !command.startsWith("-")) {
    if (command === "restart") return toResult(argv, await abortable(handlers.restartDev(args.slice(1)), signal));
    return toResult(argv, await abortable(handlers.runScript(command, args.slice(1)), signal));
  }

  return fail(
    argv,
    `${manager}: unsupported command "${args.join(" ")}". Try: install | run dev | run build\n`
  );
}

function abortable<T extends { stdout: string; stderr: string; exitCode: number }>(
  operation: Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  if (!signal) return operation;
  if (signal.aborted) return Promise.resolve(signalResult(signal.reason) as T);
  return new Promise((resolve, reject) => {
    const abort = () => resolve(signalResult(signal.reason) as T);
    signal.addEventListener("abort", abort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      }
    );
  });
}

function signalResult(reason: unknown): { stdout: string; stderr: string; exitCode: number } {
  const signal = reason === "SIGTERM" || reason === "SIGKILL" ? reason : "SIGINT";
  return {
    stdout: "",
    stderr: `${signal.toLowerCase()}\n`,
    exitCode: signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 137
  };
}

function projectFiles(
  handlers: PreviewShellHandlers
): Pick<ShellRuntimeOptions, "files" | "filesystemRoot" | "onFileWrite"> | object {
  const project = handlers.getProject();
  if (!project) return {};
  return {
    filesystemRoot: project.root,
    files: Object.fromEntries(project.listFiles().map((file) => [file.path, file.data])),
    onFileWrite(path: string, data: string) {
      const resolved = resolveProjectPath(project.root, path, project.root);
      project.writeText(resolved, data);
    }
  };
}

function listFiles(handlers: PreviewShellHandlers, context: ShellCommandContext): ShellCommandResult {
  const { argv, cwd } = context;
  const project = handlers.getProject();
  if (!project) return fail(argv, "ls: no project loaded\n");
  const flags = argv.slice(1).filter((arg) => arg.startsWith("-"));
  const targetArg = argv.slice(1).find((arg) => !arg.startsWith("-")) || ".";
  const showAll = flags.some((flag) => flag.includes("a"));
  let target: string;
  try {
    target = resolveProjectPath(project.root, targetArg, cwd);
  } catch {
    return fail(argv, `ls: ${targetArg}: Permission denied\n`);
  }
  if (project.files.has(target)) return ok(argv, `${basename(target)}\n`);
  const root = project.root;
  const prefix = target === root ? `${root}/` : `${target}/`;
  const names = new Set<string>();
  for (const file of project.listFiles()) {
    if (target !== root && file.path !== target && !file.path.startsWith(prefix)) continue;
    if (file.path === target) {
      names.add(basename(file.path));
      continue;
    }
    const rest = file.path.slice(prefix.length);
    const segment = rest.split("/")[0];
    if (segment && (showAll || !segment.startsWith("."))) names.add(segment);
  }
  if (names.size === 0 && target !== root && !project.listFiles().some((file) => file.path.startsWith(prefix))) {
    return fail(argv, `ls: ${targetArg}: No such file or directory\n`);
  }
  const listing = [...names].sort((a, b) => a.localeCompare(b)).join("\n");
  return ok(argv, listing ? `${listing}\n` : "");
}

function readFile(handlers: PreviewShellHandlers, context: ShellCommandContext): ShellCommandResult {
  const { argv, cwd, stdin } = context;
  const project = handlers.getProject();
  if (!project) return fail(argv, "cat: no project loaded\n");
  const pathArgs = argv.slice(1);
  if (pathArgs.length === 0) return stdin ? ok(argv, stdin) : fail(argv, "cat: missing path\n");
  let output = "";
  for (const pathArg of pathArgs) {
    if (pathArg === "-") {
      output += stdin;
      continue;
    }
    try {
      output += project.readText(resolveProjectPath(project.root, pathArg, cwd));
    } catch {
      return fail(argv, `cat: ${pathArg}: No such file\n`);
    }
  }
  return ok(argv, output);
}

function headFile(handlers: PreviewShellHandlers, context: ShellCommandContext): ShellCommandResult {
  const { argv, cwd, stdin } = context;
  const project = handlers.getProject();
  if (!project) return fail(argv, "head: no project loaded\n");
  const nIndex = argv.findIndex((arg) => arg === "-n");
  const lines = Number(nIndex >= 0 ? argv[nIndex + 1] : "10");
  const pathArg = argv.slice(1).find((arg, index, args) => (
    arg !== "-n" && args[index - 1] !== "-n"
  ));
  try {
    const text = pathArg ? project.readText(resolveProjectPath(project.root, pathArg, cwd)) : stdin;
    if (!pathArg && !stdin) return fail(argv, "head: missing path\n");
    return ok(argv, `${text.split("\n").slice(0, Number.isFinite(lines) ? lines : 10).join("\n")}\n`);
  } catch {
    return fail(argv, `head: ${pathArg}: No such file\n`);
  }
}

function wordCount(handlers: PreviewShellHandlers, context: ShellCommandContext): ShellCommandResult {
  const { argv, cwd, stdin } = context;
  const project = handlers.getProject();
  if (!project) return fail(argv, "wc: no project loaded\n");
  const pathArg = argv[1];
  try {
    const text = pathArg ? project.readText(resolveProjectPath(project.root, pathArg, cwd)) : stdin;
    if (!pathArg && !stdin) return fail(argv, "wc: missing path\n");
    const lineCount = text.length === 0 ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
    const wordCountValue = text.trim() ? text.trim().split(/\s+/).length : 0;
    return ok(argv, `${lineCount} ${wordCountValue} ${text.length}${pathArg ? ` ${pathArg}` : ""}\n`);
  } catch {
    return fail(argv, `wc: ${pathArg}: No such file\n`);
  }
}

function grepFiles(handlers: PreviewShellHandlers, context: ShellCommandContext): ShellCommandResult {
  const { argv, cwd, stdin } = context;
  const project = handlers.getProject();
  if (!project) return fail(argv, "grep: no project loaded\n");
  const flags = argv.slice(1).filter((arg) => arg.startsWith("-"));
  const operands = argv.slice(1).filter((arg) => !arg.startsWith("-"));
  const pattern = operands[0];
  if (!pattern) return fail(argv, "grep: missing pattern\n");
  const ignoreCase = flags.some((flag) => flag.includes("i"));
  const lineNumbers = flags.some((flag) => flag.includes("n"));
  const sources = operands.slice(1);
  const inputs: Array<{ name: string | null; text: string }> = [];
  if (sources.length === 0) inputs.push({ name: null, text: stdin });
  for (const source of sources) {
    try {
      inputs.push({
        name: sources.length > 1 ? source : null,
        text: project.readText(resolveProjectPath(project.root, source, cwd))
      });
    } catch {
      return fail(argv, `grep: ${source}: No such file\n`);
    }
  }
  const needle = ignoreCase ? pattern.toLocaleLowerCase() : pattern;
  const matches: string[] = [];
  for (const input of inputs) {
    input.text.split("\n").forEach((line, index) => {
      const haystack = ignoreCase ? line.toLocaleLowerCase() : line;
      if (!haystack.includes(needle)) return;
      matches.push(`${input.name ? `${input.name}:` : ""}${lineNumbers ? `${index + 1}:` : ""}${line}`);
    });
  }
  return matches.length ? ok(argv, `${matches.join("\n")}\n`) : { ...fail(argv, ""), exitCode: 1 };
}

function findFiles(handlers: PreviewShellHandlers, context: ShellCommandContext): ShellCommandResult {
  const { argv, cwd } = context;
  const project = handlers.getProject();
  if (!project) return fail(argv, "find: no project loaded\n");
  const startArg = argv[1] && argv[1] !== "-name" ? argv[1] : ".";
  const nameIndex = argv.indexOf("-name");
  const pattern = nameIndex >= 0 ? argv[nameIndex + 1] : null;
  try {
    const start = resolveProjectPath(project.root, startArg, cwd);
    const prefix = start === project.root ? `${project.root}/` : `${start}/`;
    const matcher = pattern ? globMatcher(pattern) : null;
    const paths = project.listFiles()
      .filter((file) => file.path === start || file.path.startsWith(prefix))
      .filter((file) => !matcher || matcher.test(basename(file.path)))
      .map((file) => startArg === "." ? `./${file.path.slice(prefix.length)}` : file.path);
    return ok(argv, paths.length ? `${paths.join("\n")}\n` : "");
  } catch {
    return fail(argv, `find: ${startArg}: Permission denied\n`);
  }
}

function mkdirPath(handlers: PreviewShellHandlers, context: ShellCommandContext): ShellCommandResult {
  const { argv, cwd } = context;
  const project = handlers.getProject();
  if (!project) return fail(argv, "mkdir: no project loaded\n");
  const pathArg = argv.slice(1).find((arg) => !arg.startsWith("-"));
  if (!pathArg) return fail(argv, "mkdir: missing path\n");
  const folder = resolveProjectPath(project.root, pathArg, cwd);
  const marker = `${folder}/.gitkeep`;
  try {
    project.readText(marker);
    return ok(argv, "");
  } catch {
    project.writeText(marker, "");
    return ok(argv, "");
  }
}

function touchFile(handlers: PreviewShellHandlers, context: ShellCommandContext): ShellCommandResult {
  const { argv, cwd } = context;
  const project = handlers.getProject();
  if (!project) return fail(argv, "touch: no project loaded\n");
  const pathArg = argv[1];
  if (!pathArg) return fail(argv, "touch: missing path\n");
  const path = resolveProjectPath(project.root, pathArg, cwd);
  try {
    project.readText(path);
    return ok(argv, "");
  } catch {
    project.writeText(path, "");
    return ok(argv, "");
  }
}

function removeFile(handlers: PreviewShellHandlers, context: ShellCommandContext): ShellCommandResult {
  const { argv, cwd } = context;
  const project = handlers.getProject();
  if (!project) return fail(argv, "rm: no project loaded\n");
  const recursive = argv.slice(1).some((arg) => arg === "-r" || arg === "-rf" || arg === "-fr");
  const pathArg = argv.slice(1).find((arg) => !arg.startsWith("-"));
  if (!pathArg) return fail(argv, "rm: missing path\n");
  const path = resolveProjectPath(project.root, pathArg, cwd);
  const matches = [...project.files.keys()].filter((candidate) => (
    candidate === path || (recursive && candidate.startsWith(`${path}/`))
  ));
  if (matches.length === 0) return fail(argv, `rm: ${pathArg}: No such file or directory\n`);
  if (!recursive && matches[0] !== path) return fail(argv, `rm: ${pathArg}: Is a directory\n`);
  for (const match of matches) project.files.delete(match);
  return ok(argv, "");
}

function copyFile(handlers: PreviewShellHandlers, context: ShellCommandContext): ShellCommandResult {
  const { argv, cwd } = context;
  const project = handlers.getProject();
  if (!project) return fail(argv, "cp: no project loaded\n");
  const [fromArg, toArg] = argv.slice(1).filter((arg) => !arg.startsWith("-"));
  if (!fromArg || !toArg) return fail(argv, "cp: usage: cp <from> <to>\n");
  try {
    const from = resolveProjectPath(project.root, fromArg, cwd);
    const to = resolveProjectPath(project.root, toArg, cwd);
    project.writeText(to, project.readText(from));
    return ok(argv, "");
  } catch {
    return fail(argv, `cp: ${fromArg}: No such file\n`);
  }
}

function moveFile(handlers: PreviewShellHandlers, context: ShellCommandContext): ShellCommandResult {
  const { argv, cwd } = context;
  const project = handlers.getProject();
  if (!project) return fail(argv, "mv: no project loaded\n");
  const fromArg = argv[1];
  const toArg = argv[2];
  if (!fromArg || !toArg) return fail(argv, "mv: usage: mv <from> <to>\n");
  const from = resolveProjectPath(project.root, fromArg, cwd);
  const to = resolveProjectPath(project.root, toArg, cwd);
  try {
    const data = project.readText(from);
    if ([...project.files.keys()].includes(to)) return fail(argv, `mv: ${toArg}: File exists\n`);
    project.writeText(to, data);
    project.files.delete(from);
    return ok(argv, "");
  } catch {
    return fail(argv, `mv: ${fromArg}: No such file\n`);
  }
}

function resolveProjectPath(root: string, input: string, cwd: string): string {
  const source = input.startsWith("/") ? input : `${cwd}/${input}`;
  const normalized: string[] = [];
  for (const segment of source.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") normalized.pop();
    else normalized.push(segment);
  }
  const path = `/${normalized.join("/")}`.replace(/\/+$/, "") || "/";
  if (path !== root && !path.startsWith(`${root}/`)) throw new Error("path escapes project root");
  return path;
}

function formatEnvironment(env: Record<string, string>): string {
  const rows = Object.entries(env).sort(([left], [right]) => left.localeCompare(right));
  return rows.length ? `${rows.map(([key, value]) => `${key}=${value}`).join("\n")}\n` : "";
}

function formatPrintf(args: string[]): string {
  const template = args[0] || "";
  let index = 1;
  return template.replace(/%s/g, () => args[index++] || "").replace(/\\n/g, "\n").replace(/\\t/g, "\t");
}

function globMatcher(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`);
}

function basename(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts.at(-1) || path;
}

function ok(argv: string[], stdout: string): ShellCommandResult {
  return { argv: [...argv], stdout, stderr: "", exitCode: 0 };
}

function fail(argv: string[], stderr: string): ShellCommandResult {
  return { argv: [...argv], stdout: "", stderr, exitCode: 1 };
}

function toResult(
  argv: string[],
  result: { stdout: string; stderr: string; exitCode: number }
): ShellCommandResult {
  return {
    argv: [...argv],
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode
  };
}
