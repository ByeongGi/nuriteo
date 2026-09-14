import type { CliEntry, RuntimeEnv } from "../types.ts";

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

export type PackageManagerProcessResult = unknown;
export type PackageManagerProcessRunner = (request: PackageManagerProcessRequest) => PackageManagerProcessResult;

export interface PackageManagerRunnerOptions {
  registry: CliRegistryLike;
  processRunner: PackageManagerProcessRunner;
  env?: RuntimeEnv;
}

export interface GuestCli {
  run(argv: string[]): import("../types.ts").CliRunResult;
}
