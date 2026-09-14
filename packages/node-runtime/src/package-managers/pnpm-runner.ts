export class PnpmRunner {
  constructor(options) {
    if (!options?.registry) throw new Error("PnpmRunner requires a CLI registry");
    if (!options?.processRunner) throw new Error("PnpmRunner requires a process runner");
    this.registry = options.registry;
    this.processRunner = options.processRunner;
    this.env = { ...(options.env || {}) };
  }

  install(cwd, args = []) {
    return this.#run(cwd, ["install", ...args]);
  }

  runScript(cwd, script, args = []) {
    return this.#run(cwd, ["run", script, ...args]);
  }

  exec(cwd, command, args = []) {
    return this.#run(cwd, ["exec", command, ...args]);
  }

  #run(cwd, args) {
    const entry = this.registry.resolve("pnpm");
    return this.processRunner({
      name: "pnpm",
      entry,
      cwd,
      args,
      env: { ...this.env }
    });
  }
}

export function createPnpmRunner(options) {
  return new PnpmRunner(options);
}

