import type { RuntimeEnv } from "../types.ts";
import type { PackageManagerProcessResult, PackageManagerProcessRunner, PackageManagerRunnerOptions } from "./types.ts";

export class YarnRunner {
  registry: PackageManagerRunnerOptions["registry"];
  processRunner: PackageManagerProcessRunner;
  env: RuntimeEnv;

  constructor(options: PackageManagerRunnerOptions) {
    if (!options?.registry) throw new Error("YarnRunner requires a CLI registry");
    if (!options?.processRunner) throw new Error("YarnRunner requires a process runner");
    this.registry = options.registry;
    this.processRunner = options.processRunner;
    this.env = { ...(options.env || {}) };
  }

  install(cwd: string, args: string[] = []): PackageManagerProcessResult {
    return this.#run(cwd, ["install", ...args]);
  }

  version(cwd = "/workspace"): PackageManagerProcessResult {
    return this.#run(cwd, ["--version"]);
  }

  runScript(cwd: string, script: string, args: string[] = []): PackageManagerProcessResult {
    return this.#run(cwd, ["run", script, ...args]);
  }

  exec(cwd: string, command: string, args: string[] = []): PackageManagerProcessResult {
    return this.#run(cwd, ["exec", command, ...args]);
  }

  #run(cwd: string, args: string[]): PackageManagerProcessResult {
    const entry = this.registry.resolve("yarn");
    return this.processRunner({
      name: "yarn",
      entry,
      cwd,
      args,
      env: { ...this.env }
    });
  }
}

export function createYarnRunner(options: PackageManagerRunnerOptions): YarnRunner {
  return new YarnRunner(options);
}
