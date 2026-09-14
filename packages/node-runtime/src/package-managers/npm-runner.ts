export class NpmRunner {
  constructor(options) {
    if (!options?.registry) throw new Error("NpmRunner requires a CLI registry");
    if (!options?.processRunner) throw new Error("NpmRunner requires a process runner");
    this.registry = options.registry;
    this.processRunner = options.processRunner;
    this.env = { ...(options.env || {}) };
  }

  install(cwd, args = []) {
    return this.#run(cwd, ["install", ...args]);
  }

  ci(cwd, args = []) {
    return this.#run(cwd, ["ci", ...args]);
  }

  runScript(cwd, script, args = []) {
    return this.#run(cwd, ["run", script, ...args]);
  }

  exec(cwd, command, args = []) {
    return this.#run(cwd, ["exec", "--", command, ...args]);
  }

  #run(cwd, args) {
    const entry = this.registry.resolve("npm");
    return this.processRunner({
      name: "npm",
      entry,
      cwd,
      args,
      env: { ...this.env }
    });
  }
}

export function createNpmRunner(options) {
  return new NpmRunner(options);
}

