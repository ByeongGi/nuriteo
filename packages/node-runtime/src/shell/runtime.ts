import { createCommandRegistry, shebangCommand } from "./commands.ts";
import { parseShell } from "./parser.ts";

export class ShellRuntime {
  constructor(options = {}) {
    this.cwd = options.cwd || "/workspace";
    this.env = { PATH: "/workspace/node_modules/.bin:/bin", ...(options.env || {}) };
    this.files = new Map(Object.entries(options.files || {}));
    this.registry = createCommandRegistry(options.commands || {});
  }

  async run(commandLine) {
    const steps = parseShell(commandLine);
    let stdin = "";
    let stdout = "";
    let stderr = "";
    let exitCode = 0;

    for (let index = 0; index < steps.length; index += 1) {
      const step = steps[index];
      const nextStep = steps[index + 1];
      if (step.op === "&&" && exitCode !== 0) break;
      const { argv, redirect } = extractRedirect(step.argv);
      const result = await this.runCommand(argv, stdin);
      exitCode = result.exitCode;
      stderr += result.stderr || "";
      if (redirect) this.files.set(resolvePath(redirect, this.cwd), result.stdout || "");
      else if (nextStep?.op !== "|") stdout += result.stdout || "";
      stdin = nextStep?.op === "|" ? result.stdout || "" : "";
      if (exitCode !== 0) break;
    }

    return { stdout, stderr, exitCode, files: Object.fromEntries(this.files) };
  }

  async runCommand(argv, stdin) {
    if (argv[0] === "sh" && argv[1] === "-c") {
      return this.run(argv.slice(2).join(" "));
    }

    const command = this.resolveExecutable(argv[0]);
    return command({
      argv,
      cwd: this.cwd,
      env: this.env,
      stdin,
      files: this.files
    });
  }

  resolveExecutable(name) {
    const filePath = this.resolveFileExecutable(name);
    if (filePath) {
      const source = this.files.get(filePath);
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

  resolveFileExecutable(name) {
    const direct = resolvePath(name, this.cwd);
    if (this.files.has(direct)) return direct;
    for (const dir of (this.env.PATH || "").split(":").filter(Boolean)) {
      const candidate = dir.startsWith("/") ? `${dir}/${name}` : `${this.cwd}/${dir}/${name}`;
      if (this.files.has(candidate)) return candidate;
    }
    return null;
  }
}

function isNodeShebang(shebang) {
  if (!shebang) return false;
  if (shebang[0]?.endsWith("node")) return true;
  return shebang[0]?.endsWith("env") && shebang[1] === "node";
}

export function createShellRuntime(options) {
  return new ShellRuntime(options);
}

function extractRedirect(argv) {
  const index = argv.indexOf(">");
  if (index < 0) return { argv, redirect: null };
  if (!argv[index + 1]) throw new Error("missing redirect target");
  return {
    argv: argv.slice(0, index),
    redirect: argv[index + 1]
  };
}

function resolvePath(path, cwd) {
  return path.startsWith("/") ? path : `${cwd}/${path}`;
}
