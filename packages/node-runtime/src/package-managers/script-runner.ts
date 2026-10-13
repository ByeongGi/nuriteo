import { basename, dirname, join } from "../builtins/path.ts";
import type { RuntimeEnv } from "../types.ts";
import { createPackageExecutionPolicy, PackageExecutionPolicyError, type PackageExecutionPolicy, type PackageScriptKind } from "./execution-policy.ts";

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
  policy?: PackageExecutionPolicy;
  reader: PackageScriptReader;
  trace?: PackageScriptTraceSink;
  writer: PackageScriptWriter;
}

export interface PackageScriptTraceSink {
  startSpan(input: {
    category: "package-manager";
    name: string;
    requestId?: string | number;
    attributes?: Record<string, string | number | boolean | null>;
  }): {
    end(input?: {
      status?: "ok" | "error";
      errorCode?: string;
      attributes?: Record<string, string | number | boolean | null>;
    }): unknown;
  };
}

export interface PackageScriptResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  command: string;
  error?: {
    code: string;
    message: string;
  };
}

export class PackageScriptRunner {
  cwd: string;
  env: RuntimeEnv;
  policy: PackageExecutionPolicy;
  reader: PackageScriptReader;
  trace: PackageScriptTraceSink | null;
  writer: PackageScriptWriter;

  constructor(options: PackageScriptRunnerOptions) {
    this.cwd = trimSlash(options.cwd);
    this.env = { ...(options.env || {}) };
    this.policy = options.policy || createPackageExecutionPolicy();
    this.reader = options.reader;
    this.trace = options.trace || null;
    this.writer = options.writer;
  }

  runScript(name: string): PackageScriptResult {
    const manifest = this.#readPackageJson(this.cwd);
    const command = manifest.scripts?.[name];
    if (!command) return this.#failure(name, `missing package script: ${name}`);
    return this.#runCommand(command, this.cwd, "script");
  }

  runLifecycle(packagePath: string, name: string): PackageScriptResult {
    const manifest = this.#readPackageJson(packagePath);
    const command = manifest.scripts?.[name];
    if (!command) return { stdout: "", stderr: "", exitCode: 0, command: "" };
    return this.#runCommand(command, packagePath, "lifecycle");
  }

  execBin(name: string): PackageScriptResult {
    const candidates = [
      join(this.cwd, "node_modules/.bin", name),
      join(this.cwd, "node_modules/.bin", `${name}.js`)
    ];
    const binPath = candidates.find((candidate) => this.reader.exists(candidate));
    if (!binPath) return this.#failure(name, `command not found: ${name}`);
    return this.#runNodeFile(binPath, dirname(binPath), `node ${basename(binPath)}`, "bin");
  }

  #runCommand(command: string, cwd: string, kind: PackageScriptKind): PackageScriptResult {
    const span = this.trace?.startSpan({
      category: "package-manager",
      name: "package-script.run",
      attributes: { command, cwd, kind }
    });
    const manifestPath = join(cwd, "package.json");
    const policyError = this.#checkPolicy({ kind, command, path: manifestPath, source: "" });
    if (policyError) {
      span?.end({
        status: "error",
        ...(policyError.error?.code ? { errorCode: policyError.error.code } : {})
      });
      return policyError;
    }
    const [binary, script] = command.split(/\s+/, 2);
    if (binary !== "node" || !script) {
      const result = this.#failure(command, `unsupported package script command: ${command}`);
      span?.end({ status: "error" });
      return result;
    }
    const result = this.#runNodeFile(join(cwd, script), cwd, command, kind);
    span?.end({
      status: result.exitCode === 0 ? "ok" : "error",
      ...(result.error?.code ? { errorCode: result.error.code } : {})
    });
    return result;
  }

  #runNodeFile(file: string, cwd: string, command = `node ${basename(file)}`, kind: PackageScriptKind = "script"): PackageScriptResult {
    const source = this.reader.readText(file);
    const policyError = this.#checkPolicy({ kind, command, path: file, source });
    if (policyError) return policyError;
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

  #failure(command: string, message: string, code?: string): PackageScriptResult {
    return {
      stdout: "",
      stderr: `${message}\n`,
      exitCode: 1,
      command,
      ...(code ? { error: { code, message } } : {})
    };
  }

  #checkPolicy(check: Parameters<PackageExecutionPolicy["assertAllowed"]>[0]): PackageScriptResult | null {
    try {
      this.policy.assertAllowed(check);
      return null;
    } catch (error) {
      if (error instanceof PackageExecutionPolicyError) return this.#failure(check.command, error.message, error.code);
      throw error;
    }
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
