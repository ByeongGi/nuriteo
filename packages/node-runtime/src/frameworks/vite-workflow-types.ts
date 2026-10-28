

import type { ViteProductDependencyArtifact, ViteProductPackageArtifact } from "./vite-artifacts.ts";

import type { LoopbackNetwork } from "../net/index.ts";
import type { WasmAdapterPolicy } from "../wasm-adapters/index.ts";
import type { WorkspaceModuleReader } from "../modules/index.ts";
import type { ViteDependencyMaterializationPlan, ViteRuntimeCapabilityStatus, ViteRuntimeCapability } from "./vite-materialization.ts";
import type { CliRunResult } from "../types.ts";
import type { CliEvaluationFsTraceEntry, CliEvaluationWorkerFactory } from "../package-managers/cli-evaluator.ts";
import type { CliEntryReadiness } from "../package-managers/cli-entry-readiness.ts";
import type { CliModuleGraph } from "../package-managers/cli-module-graph.ts";

export type ViteProductPackageManager = "npm" | "pnpm" | "yarn";
export type ViteProductTemplate = "react" | "vue-runtime" | "svelte" | "vanilla";

export interface ViteProductWorkflowOptions {
  manager: ViteProductPackageManager;
  template?: ViteProductTemplate;
  vitePackageArtifact?: ViteProductPackageArtifact;
  dependencyArtifacts?: ViteProductDependencyArtifact[];
  projectId?: string;
  projectRoot?: string;
  initialLabel?: string;
  network?: LoopbackNetwork;
  port?: number;
  wasmAdapterPolicy?: WasmAdapterPolicy;
}

export interface ViteProductDependencyArtifactClosureOptions {
  initialArtifacts?: ViteProductDependencyArtifact[];
  manager: ViteProductPackageManager;
  maxIterations?: number;
  nodeModulesRoot: string;
  projectRoot?: string;
  reader: WorkspaceModuleReader;
  vitePackageArtifact: ViteProductPackageArtifact;
  wasmAdapterPolicy?: WasmAdapterPolicy;
}

export interface ViteProductDependencyArtifactClosureResult {
  artifacts: ViteProductDependencyArtifact[];
  iterations: ViteProductDependencyArtifactClosureIteration[];
  remainingPlan: ViteDependencyMaterializationPlan;
}

export interface ViteProductDependencyArtifactClosureIteration {
  extracted: string[];
  plan: ViteDependencyMaterializationPlan;
}


export interface ViteProductWorkflowResult {
  runtime: "browser-guest-node-runtime";
  manager: ViteProductPackageManager;
  template: ViteProductTemplate;
  projectId: string;
  install: ViteProductInstallResult;
  realCliReadiness: ViteRealCliReadiness;
  devServer: ViteProductDevServerSnapshot;
  preview: ViteProductPreviewResult;
  hmr: ViteProductHmrResult;
  build: ViteProductBuildResult;
  reloadRecovery: ViteProductReloadRecoveryResult;
}

export interface ViteProductCliBackedWorkflowResult extends ViteProductWorkflowResult {
  devServer: ViteProductDevServerSnapshot;
  build: ViteProductBuildResult;
}

export interface ViteProductInstallResult {
  installed: boolean;
  lockfile: string;
  packages: string[];
  vitePackageSource: ViteProductPackageSource;
}

export type ViteProductPackageSource = "stub" | "mounted-artifact";

export interface ViteProductCliExecutionResult extends CliRunResult {
  args: string[];
  asyncBindingReadinessBlocker: ViteProductAsyncBindingReadinessBlocker | null;
  asyncModuleBlocker: ViteProductAsyncModuleBlocker | null;
  buildRegistrations: ViteProductCliBuildRegistration[];
  cwd: string;
  fsTrace?: CliEvaluationFsTraceEntry[];
  hmrRegistrations: ViteProductCliHmrRegistration[];
  mode: ViteProductCliExecutionMode;
  serverRegistrations: ViteProductCliServerRegistration[];
  transformRegistrations: ViteProductCliTransformRegistration[];
}

export interface ViteProductAsyncModuleBlocker {
  module: string;
  reason: "sync-require-of-async-esm";
}

export interface ViteProductAsyncBindingReadinessBlocker {
  reason: "async-binding-namespace-not-ready";
}

export type ViteProductCliExecutionMode = "async-cli-module-evaluation" | "isolated-snapshot-cli-module-evaluation" | "worker-backed-cli-module-evaluation";

export interface ViteProductCliExecutionOptions {
  isolation?: "shared" | "snapshot" | "worker";
  readyTimeoutMs?: number;
  traceFs?: boolean;
  workerFactory?: CliEvaluationWorkerFactory;
  workerTimeoutMs?: number;
}

export interface ViteProductCliBuildRegistration {
  command: "build";
  outDir: string;
  source: "vite-cli";
}

export interface ViteProductCliHmrRegistration {
  channel: "hmr";
  sendUpdate?: ViteProductCliHmrSendUpdate;
  source: "vite-cli";
  transport: "loopback";
}

export type ViteProductCliHmrSendUpdate = (
  update: ViteProductHmrUpdate
) => void | ViteProductHmrUpdate | Promise<void | ViteProductHmrUpdate>;

export interface ViteProductCliServerRegistration {
  command: "dev";
  host: string;
  port: number;
  source: "vite-cli";
}

export interface ViteProductCliTransformRegistration {
  mode: "browser-esm";
  source: "vite-cli";
  transformRequest?: ViteProductCliTransformRequest;
}

export type ViteProductCliTransformRequest = (
  request: ViteProductCliTransformRequestInput
) => ViteProductCliTransformResult | string | Promise<ViteProductCliTransformResult | string>;

export interface ViteProductCliTransformRequestInput {
  path: string;
  source: string;
}

export interface ViteProductCliTransformResult {
  code: string;
  map?: unknown;
}

export interface ViteProductDevServerSnapshot {
  moduleTransform: ViteProductModuleTransformSource;
  port: number;
  running: boolean;
  restartCount: number;
  requests: string[];
  command: string | null;
  source: ViteProductDevServerSource;
  cliEntrypoint: string | null;
  processPid: number | null;
  processStarted: boolean;
  processExited: boolean;
}

export type ViteProductDevServerSource = "adapter" | "package-script" | "cli-execution";
export type ViteProductModuleTransformSource = "adapter" | "vite-cli";

export interface ViteProductHmrUpdate {
  type: "update";
  updates: ViteProductHmrPayloadUpdate[];
}

export interface ViteProductHmrPayloadUpdate {
  type: "js-update" | "css-update";
  path: string;
  acceptedPath: string;
  timestamp: number;
  explicitImportRequired?: boolean;
  ssrInvalidates?: string[];
  label?: string;
}

export interface ViteProductHmrSocket {
  onmessage?: (event: { data: string }) => void;
  onclose?: () => void;
  close?: () => void;
  sendMessage?: (payload: unknown) => void;
}

export interface ViteProductPreviewResult {
  statusCode: number;
  headers?: Record<string, string>;
  body: string | Uint8Array;
}

export interface ViteProductHmrResult {
  before: string;
  after: string;
  statePreserved: boolean;
}

export interface ViteProductSourceEditResult extends ViteProductHmrResult {
  path: string;
  update: ViteProductHmrUpdate;
}

export interface ViteProductBuildResult {
  files: string[];
  distSmoke: string;
  command: string | null;
  cliEntrypoint: string | null;
}

export interface ViteProductReloadRecoveryResult {
  restarted: boolean;
  previewAfterRestart: string;
}

export interface ViteRealCliReadiness {
  status: "blocked";
  capabilityStatus: ViteRuntimeCapabilityStatus[];
  cliEntrypoint: string;
  cliEntryReadiness: CliEntryReadiness;
  cliModuleGraph: CliModuleGraph;
  dependencyMaterializationPlan: ViteDependencyMaterializationPlan;
  missingCapabilities: ViteRuntimeCapability[];
  nextAction: string;
  vitePackageSource: ViteProductPackageSource;
}
