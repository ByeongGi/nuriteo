import type { CliEntry, CliRunResult, RuntimeEnv } from "../types.ts";

export type PackageManagerCommandKind =
  | "version"
  | "install"
  | "ci"
  | "run-script"
  | "exec"
  | "unknown";

export type PackageManagerBootMode =
  | "artifact-entry-preflight"
  | "cli-module-evaluation"
  | "install-plan-application"
  | "script-runner-application"
  | "blocked-real-cli-evaluation";

export type PackageManagerErrorCode =
  | "ERR_PM_CLI_ENTRY_UNSUPPORTED"
  | "ERR_PM_REAL_CLI_EVALUATION_REQUIRED";

export interface CliRegistryLike {
  resolve(name: string): CliEntry;
}

export interface PackageManagerProcessRequest {
  name: "npm" | "pnpm" | "yarn";
  entry: CliEntry;
  cwd: string;
  args: string[];
  env: RuntimeEnv;
}

export interface PackageManagerProcessResult extends CliRunResult {
  args: string[];
  cwd: string;
  runtime?: "browser-guest-node-runtime" | "host-node-test-helper";
  bootMode?: PackageManagerBootMode;
  commandKind?: PackageManagerCommandKind;
  error?: {
    code?: PackageManagerErrorCode;
    message: string;
    nextAction?: string;
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
  cliModuleEvaluation?: {
    reader: import("../modules/index.ts").WorkspaceModuleReader;
    root?: string;
  };
  workspace?: {
    reader: import("./workspace.ts").PackageManagerWorkspaceReader;
    writer: import("./workspace.ts").PackageManagerWorkspaceWriter;
    linkStrategy?: import("./workspace.ts").PackageManagerLinkStrategy;
    scriptPolicy?: import("./execution-policy.ts").PackageExecutionPolicy;
  };
}
