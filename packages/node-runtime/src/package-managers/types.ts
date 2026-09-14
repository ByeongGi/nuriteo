import type { CliEntry, CliRunResult, RuntimeEnv } from "../types.ts";

export interface CliRegistryLike {
  resolve(name: string): CliEntry;
}

export interface PackageManagerProcessRequest {
  name: "npm" | "pnpm";
  entry: CliEntry;
  cwd: string;
  args: string[];
  env: RuntimeEnv;
}

export interface PackageManagerProcessResult extends CliRunResult {
  args: string[];
  cwd: string;
  runtime?: "browser-guest-node-runtime" | "host-node-test-helper";
  bootMode?: string;
  error?: {
    code?: string;
    message: string;
  };
  signal?: string | null;
}

export type PackageManagerProcessRunner = (request: PackageManagerProcessRequest) => PackageManagerProcessResult;

export interface PackageManagerRunnerOptions {
  registry: CliRegistryLike;
  processRunner: PackageManagerProcessRunner;
  env?: RuntimeEnv;
}

export interface GuestCli {
  run(argv: string[]): import("../types.ts").CliRunResult;
}

export interface CliArtifactReader {
  readText(path: string): string;
}

export interface GuestRuntimeProcessRunnerOptions {
  artifacts: CliArtifactReader;
}
