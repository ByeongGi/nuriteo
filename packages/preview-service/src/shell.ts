import {
  createTerminalSession,
  type TerminalRunResult,
  type TerminalSession
} from "../../node-runtime/src/shell/index.ts";
import type { ProjectWorkspaceStore } from "../../browser-host/src/storage/index.ts";
import type { ShellCommandMap, ShellCommandResult } from "../../node-runtime/src/shell/types.ts";

export interface PreviewShellHandlers {
  getCwd: () => string;
  getProject: () => ProjectWorkspaceStore | null;
  install: () => Promise<{ stdout: string; stderr: string; exitCode: number }>;
  runDev: () => Promise<{ stdout: string; stderr: string; exitCode: number }>;
  runBuild: () => Promise<{ stdout: string; stderr: string; exitCode: number }>;
  restartDev: () => Promise<{ stdout: string; stderr: string; exitCode: number }>;
  onChunk?: (chunk: { stream: "stdout" | "stderr"; data: string }) => void;
}

export interface PreviewShellSession {
  run(command: string): Promise<TerminalRunResult>;
  cancel(): boolean;
  session: TerminalSession;
}

const HELP = [
  "Cargo Container shell",
  "",
  "Built-ins:",
  "  help                 Show this help",
  "  clear                Clear the terminal UI",
  "  pwd                  Print working directory",
  "  ls [path]            List project files",
  "  cat <path>           Print a project file",
  "  head <path> [n]      Print first n lines (default 10)",
  "  wc <path>            Line/word/byte counts",
  "  mkdir <path>         Create folder marker (.gitkeep)",
  "  touch <path>         Create empty file",
  "  rm <path>            Delete a project file",
  "  mv <from> <to>       Rename/move a project file",
  "  echo <text>          Print text",
  "",
  "Package scripts (wired to preview workflow):",
  "  npm install | pnpm install",
  "  npm run dev | pnpm run dev",
  "  npm run build | pnpm run build",
  "  npm run start        Alias for run preview",
  "",
  "Notes:",
  "  yarn                 Unsupported (v1 evaluation-only candidate). Use npm or pnpm.",
  ""
].join("\n");

const YARN_UNSUPPORTED =
  "yarn: unsupported in cargo-container product shell (yarn v1 is evaluation-only). Use npm or pnpm instead.\n";

export function createPreviewShellSession(handlers: PreviewShellHandlers): PreviewShellSession {
  const commands: ShellCommandMap = {
    help: ({ argv }) => ok(argv, `${HELP}\n`),
    clear: ({ argv }) => ok(argv, ""),
    pwd: ({ argv }) => ok(argv, `${handlers.getCwd()}\n`),
    echo: ({ argv }) => ok(argv, `${argv.slice(1).join(" ")}\n`),
    ls: ({ argv }) => listFiles(handlers, argv),
    cat: ({ argv }) => readFile(handlers, argv),
    head: ({ argv }) => headFile(handlers, argv),
    wc: ({ argv }) => wordCount(handlers, argv),
    mkdir: ({ argv }) => mkdirPath(handlers, argv),
    touch: ({ argv }) => touchFile(handlers, argv),
    rm: ({ argv }) => removeFile(handlers, argv),
    mv: ({ argv }) => moveFile(handlers, argv),
    npm: (context) => runPackageManager(handlers, "npm", context.argv),
    pnpm: (context) => runPackageManager(handlers, "pnpm", context.argv),
    yarn: ({ argv }) => fail(argv, YARN_UNSUPPORTED)
  };

  let cwd = handlers.getCwd();
  let session = createTerminalSession({
    cwd,
    commands,
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

async function runPackageManager(
  handlers: PreviewShellHandlers,
  manager: "npm" | "pnpm",
  argv: string[]
): Promise<ShellCommandResult> {
  const args = argv.slice(1);
  const [command, script, ...rest] = args;

  if (!command || command === "--version" || command === "-v" || command === "version") {
    return ok(argv, `${manager} (cargo-container preview shell)\n`);
  }

  if (command === "install" || command === "i" || command === "add") {
    return toResult(argv, await handlers.install());
  }

  if (command === "run" || command === "run-script") {
    if (!script) return fail(argv, `${manager}: missing script name\n`);
    if (rest.length > 0) {
      return fail(argv, `${manager}: extra script args are not supported yet (${rest.join(" ")})\n`);
    }
    if (script === "dev" || script === "start") return toResult(argv, await handlers.runDev());
    if (script === "build") return toResult(argv, await handlers.runBuild());
    if (script === "restart") return toResult(argv, await handlers.restartDev());
    return fail(argv, `${manager}: unsupported script "${script}". Try: install, run dev, run build\n`);
  }

  if (command === "start") {
    return toResult(argv, await handlers.runDev());
  }

  return fail(
    argv,
    `${manager}: unsupported command "${args.join(" ")}". Try: install | run dev | run build\n`
  );
}

function listFiles(handlers: PreviewShellHandlers, argv: string[]): ShellCommandResult {
  const project = handlers.getProject();
  if (!project) return fail(argv, "ls: no project loaded\n");
  const root = project.root;
  const targetArg = argv[1] || ".";
  const target = resolveProjectPath(root, targetArg);
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
    if (segment) names.add(segment);
  }
  const listing = [...names].sort((a, b) => a.localeCompare(b)).join("\n");
  return ok(argv, listing ? `${listing}\n` : "");
}

function readFile(handlers: PreviewShellHandlers, argv: string[]): ShellCommandResult {
  const project = handlers.getProject();
  if (!project) return fail(argv, "cat: no project loaded\n");
  const pathArg = argv[1];
  if (!pathArg) return fail(argv, "cat: missing path\n");
  const path = resolveProjectPath(project.root, pathArg);
  try {
    return ok(argv, project.readText(path));
  } catch {
    return fail(argv, `cat: ${pathArg}: No such file\n`);
  }
}

function headFile(handlers: PreviewShellHandlers, argv: string[]): ShellCommandResult {
  const project = handlers.getProject();
  if (!project) return fail(argv, "head: no project loaded\n");
  const pathArg = argv[1];
  if (!pathArg) return fail(argv, "head: missing path\n");
  const lines = Number(argv[2] || "10");
  try {
    const text = project.readText(resolveProjectPath(project.root, pathArg));
    return ok(argv, `${text.split("\n").slice(0, Number.isFinite(lines) ? lines : 10).join("\n")}\n`);
  } catch {
    return fail(argv, `head: ${pathArg}: No such file\n`);
  }
}

function wordCount(handlers: PreviewShellHandlers, argv: string[]): ShellCommandResult {
  const project = handlers.getProject();
  if (!project) return fail(argv, "wc: no project loaded\n");
  const pathArg = argv[1];
  if (!pathArg) return fail(argv, "wc: missing path\n");
  try {
    const text = project.readText(resolveProjectPath(project.root, pathArg));
    const lineCount = text.length === 0 ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
    const wordCountValue = text.trim() ? text.trim().split(/\s+/).length : 0;
    return ok(argv, `${lineCount} ${wordCountValue} ${text.length} ${pathArg}\n`);
  } catch {
    return fail(argv, `wc: ${pathArg}: No such file\n`);
  }
}

function mkdirPath(handlers: PreviewShellHandlers, argv: string[]): ShellCommandResult {
  const project = handlers.getProject();
  if (!project) return fail(argv, "mkdir: no project loaded\n");
  const pathArg = argv[1];
  if (!pathArg) return fail(argv, "mkdir: missing path\n");
  const folder = resolveProjectPath(project.root, pathArg);
  const marker = `${folder}/.gitkeep`;
  try {
    project.readText(marker);
    return ok(argv, "");
  } catch {
    project.writeText(marker, "");
    return ok(argv, "");
  }
}

function touchFile(handlers: PreviewShellHandlers, argv: string[]): ShellCommandResult {
  const project = handlers.getProject();
  if (!project) return fail(argv, "touch: no project loaded\n");
  const pathArg = argv[1];
  if (!pathArg) return fail(argv, "touch: missing path\n");
  const path = resolveProjectPath(project.root, pathArg);
  try {
    project.readText(path);
    return ok(argv, "");
  } catch {
    project.writeText(path, "");
    return ok(argv, "");
  }
}

function removeFile(handlers: PreviewShellHandlers, argv: string[]): ShellCommandResult {
  const project = handlers.getProject();
  if (!project) return fail(argv, "rm: no project loaded\n");
  const pathArg = argv[1];
  if (!pathArg) return fail(argv, "rm: missing path\n");
  const path = resolveProjectPath(project.root, pathArg);
  if (![...project.files.keys()].includes(path)) return fail(argv, `rm: ${pathArg}: No such file\n`);
  project.files.delete(path);
  return ok(argv, "");
}

function moveFile(handlers: PreviewShellHandlers, argv: string[]): ShellCommandResult {
  const project = handlers.getProject();
  if (!project) return fail(argv, "mv: no project loaded\n");
  const fromArg = argv[1];
  const toArg = argv[2];
  if (!fromArg || !toArg) return fail(argv, "mv: usage: mv <from> <to>\n");
  const from = resolveProjectPath(project.root, fromArg);
  const to = resolveProjectPath(project.root, toArg);
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

function resolveProjectPath(root: string, input: string): string {
  if (input === "." || input === "./") return root;
  if (input.startsWith("/")) {
    if (input === root || input.startsWith(`${root}/`)) return input.replace(/\/+$/, "") || root;
    return `${root}/${input.replace(/^\/+/, "")}`.replace(/\/+/g, "/");
  }
  return `${root}/${input.replace(/^\.\//, "")}`.replace(/\/+/g, "/");
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
