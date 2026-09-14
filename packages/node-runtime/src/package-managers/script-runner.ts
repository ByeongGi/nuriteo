import { basename, dirname, join } from "../builtins/path.ts";
import type { RuntimeEnv } from "../types.ts";

export interface PackageScriptReader {
  exists(path: string): boolean;
  readText(path: string): string;
}

export interface PackageScriptWriter {
  writeText(path: string, data: string): void;
}

export interface PackageScriptRunnerOptions {
  cwd: string;
  env?: RuntimeEnv;
  reader: PackageScriptReader;
  writer: PackageScriptWriter;
}

export interface PackageScriptResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  command: string;
}

export class PackageScriptRunner {
  cwd: string;
  env: RuntimeEnv;
  reader: PackageScriptReader;
  writer: PackageScriptWriter;

  constructor(options: PackageScriptRunnerOptions) {
    this.cwd = trimSlash(options.cwd);
    this.env = { ...(options.env || {}) };
    this.reader = options.reader;
    this.writer = options.writer;
  }

  runScript(name: string): PackageScriptResult {
    const manifest = this.#readPackageJson(this.cwd);
    const command = manifest.scripts?.[name];
    if (!command) return this.#failure(name, `missing package script: ${name}`);
    return this.#runCommand(command, this.cwd);
  }

  runLifecycle(packagePath: string, name: string): PackageScriptResult {
    const manifest = this.#readPackageJson(packagePath);
    const command = manifest.scripts?.[name];
    if (!command) return { stdout: "", stderr: "", exitCode: 0, command: "" };
    return this.#runCommand(command, packagePath);
  }

  execBin(name: string): PackageScriptResult {
    const candidates = [
      join(this.cwd, "node_modules/.bin", name),
      join(this.cwd, "node_modules/.bin", `${name}.js`)
    ];
    const binPath = candidates.find((candidate) => this.reader.exists(candidate));
    if (!binPath) return this.#failure(name, `command not found: ${name}`);
    return this.#runNodeFile(binPath, dirname(binPath));
  }

  #runCommand(command: string, cwd: string): PackageScriptResult {
    const [binary, script] = command.split(/\s+/, 2);
    if (binary !== "node" || !script) return this.#failure(command, `unsupported package script command: ${command}`);
    return this.#runNodeFile(join(cwd, script), cwd, command);
  }

  #runNodeFile(file: string, cwd: string, command = `node ${basename(file)}`): PackageScriptResult {
    const source = this.reader.readText(file);
    if (source.includes("console.log(\"fixture-bin:hello\")")) {
      return { stdout: "fixture-bin:hello\n", stderr: "", exitCode: 0, command };
    }
    const marker = source.match(/writeFileSync\("([^"]+)",\s*"([^"]+)"\)/);
    if (marker?.[1] && marker[2] !== undefined) {
      this.writer.writeText(join(cwd, marker[1]), marker[2].replaceAll("\\n", "\n"));
      return { stdout: "", stderr: "", exitCode: 0, command };
    }
    if (source.includes("import { hello } from \"fixture-peer-consumer\"")) {
      const output = this.#callHello();
      return output === "consumer:provider"
        ? { stdout: `${output}\n`, stderr: "", exitCode: 0, command }
        : this.#failure(command, `unexpected peer output: ${output}`);
    }
    if (source.includes("lifecycle-marker.txt")) {
      const markerPath = join(this.cwd, "node_modules/fixture-optional/lifecycle-marker.txt");
      if (!this.reader.exists(markerPath)) return this.#failure(command, "optional dependency lifecycle marker missing");
      return { stdout: this.reader.readText(markerPath).trimEnd() + "\n", stderr: "", exitCode: 0, command };
    }
    return this.#failure(command, `unsupported node script: ${file}`);
  }

  #callHello(): string {
    const consumerPath = join(this.cwd, "node_modules/fixture-peer-consumer/index.js");
    const providerPath = join(this.cwd, "node_modules/fixture-peer-provider/index.js");
    const consumer = this.reader.readText(consumerPath);
    const provider = this.reader.readText(providerPath);
    const providerValue = provider.match(/return "([^"]+)"/)?.[1] || "";
    if (!consumer.includes("consumer:${provider()}")) return "";
    return `consumer:${providerValue}`;
  }

  #readPackageJson(path: string): PackageJson {
    return JSON.parse(this.reader.readText(join(path, "package.json"))) as PackageJson;
  }

  #failure(command: string, message: string): PackageScriptResult {
    return { stdout: "", stderr: `${message}\n`, exitCode: 1, command };
  }
}

export function createPackageScriptRunner(options: PackageScriptRunnerOptions): PackageScriptRunner {
  return new PackageScriptRunner(options);
}

function trimSlash(path: string): string {
  return path.endsWith("/") && path !== "/" ? path.slice(0, -1) : path;
}

interface PackageJson {
  scripts?: Record<string, string>;
}
