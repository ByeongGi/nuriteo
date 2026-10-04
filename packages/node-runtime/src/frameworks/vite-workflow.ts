import { join } from "../builtins/path.ts";
import {
  ViteProductPackageArtifactError,
  createViteDependencyArtifactsFromWorkspace,
  decodeBase64,
  mergeViteDependencyArtifacts,
  normalizePackageArtifactPath,
  readVitePackageBinPath,
  readerExists
} from "./vite-artifacts.ts";
import type {
  VitePackageManifest,
  ViteProductDependencyArtifact,
  ViteProductPackageArtifact
} from "./vite-artifacts.ts";
export {
  ViteProductPackageArtifactError,
  createViteDependencyArtifactFromWorkspace,
  createViteDependencyArtifactsFromPlan,
  createViteDependencyArtifactsFromWorkspace,
  createVitePackageArtifactFromWorkspace,
  mergeViteDependencyArtifacts
} from "./vite-artifacts.ts";
export type {
  ViteProductDependencyArtifact,
  ViteProductDependencyArtifactFromWorkspaceOptions,
  ViteProductDependencyArtifactMergeResult,
  ViteProductDependencyArtifactsFromPlanOptions,
  ViteProductDependencyArtifactsFromWorkspaceOptions,
  ViteProductPackageArtifact,
  ViteProductPackageArtifactErrorCode,
  ViteProductPackageArtifactFromWorkspaceOptions
} from "./vite-artifacts.ts";
import { spawnRuntimeChild, type RuntimeChildProcess } from "../child-process.ts";
import { createLoopbackNetwork, type LoopbackFetchOptions, type LoopbackNetwork, type RuntimeHttpResponse } from "../net/index.ts";
import {
  createAsyncCliModuleEvaluator,
  createIsolatedAsyncCliModuleEvaluator,
  createWorkerBackedAsyncCliModuleEvaluator,
  type CliEvaluationCapturedGlobalCall,
  type CliEvaluationFsTraceEntry,
  type CliEvaluationWorkerFactory
} from "../package-managers/cli-evaluator.ts";
import { analyzeCliModuleGraph, type CliModuleGraph, type CliModuleGraphIssue } from "../package-managers/cli-module-graph.ts";
import { inspectCliEntryReadiness, type CliEntryReadiness } from "../package-managers/cli-entry-readiness.ts";
import { MemoryPackageManagerWorkspace, type PackageManagerWorkspaceMount } from "../package-managers/workspace.ts";
import type { WasmAdapterPolicy, WasmAdapterPolicyAction } from "../wasm-adapters/index.ts";
import type { WorkspaceModuleReader } from "../modules/index.ts";
import { transpileTypeScript } from "../transforms/typescript.ts";
import type { CliRunResult, RuntimeEnv } from "../types.ts";
import type {
  ViteDependencyMaterializationItem,
  ViteDependencyMaterializationKind,
  ViteDependencyMaterializationOptionalItem,
  ViteDependencyMaterializationOptionalKind,
  ViteDependencyMaterializationPlan,
  ViteDependencyMaterializationSummary,
  ViteDependencyMaterializationWasmReplacement,
  ViteRuntimeCapability,
  ViteRuntimeCapabilityStatus
} from "./vite-materialization.ts";
export type {
  ViteDependencyMaterializationItem,
  ViteDependencyMaterializationKind,
  ViteDependencyMaterializationOptionalItem,
  ViteDependencyMaterializationOptionalKind,
  ViteDependencyMaterializationPlan,
  ViteDependencyMaterializationSummary,
  ViteDependencyMaterializationWasmReplacement,
  ViteRuntimeCapability,
  ViteRuntimeCapabilityStatus,
  ViteRuntimeReadinessCapability
} from "./vite-materialization.ts";

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



export class ViteProductWorkflow {
  readonly manager: ViteProductPackageManager;
  readonly template: ViteProductTemplate;
  readonly projectId: string;
  readonly projectRoot: string;
  readonly dependencyArtifacts: ViteProductDependencyArtifact[];
  readonly vitePackageArtifact: ViteProductPackageArtifact | null;
  readonly wasmAdapterPolicy: WasmAdapterPolicy | null;
  readonly workspace: MemoryPackageManagerWorkspace;
  readonly network: LoopbackNetwork;
  #state = { count: 1 };
  #port: number;
  #restartCount = 0;
  #running = false;
  #listener: { port: number; close: () => void } | null = null;
  #devProcess: RuntimeChildProcess | null = null;
  #devServerCommand: string | null = null;
  #devServerSource: ViteProductDevServerSource = "adapter";
  #devServerCliEntrypoint: string | null = null;
  #moduleTransformSource: ViteProductModuleTransformSource = "adapter";
  #cliHmrSendUpdate: ViteProductCliHmrSendUpdate | null = null;
  #cliTransformRequest: ViteProductCliTransformRequest | null = null;
  #buildCommand: string | null = null;
  #buildCliEntrypoint: string | null = null;
  #requests: string[] = [];
  #hmrUpdates: ViteProductHmrUpdate[] = [];
  #hmrSockets = new Set<ViteProductHmrSocket>();

  constructor(options: ViteProductWorkflowOptions) {
    this.manager = options.manager;
    this.template = options.template || "react";
    this.projectId = options.projectId || `vite-${this.template}-${options.manager}`;
    this.projectRoot = options.projectRoot || "/workspace/project";
    this.dependencyArtifacts = options.dependencyArtifacts || [];
    this.vitePackageArtifact = options.vitePackageArtifact || null;
    this.wasmAdapterPolicy = options.wasmAdapterPolicy || null;
    this.network = options.network || createLoopbackNetwork();
    this.#port = options.port ?? 5173;
    this.workspace = new MemoryPackageManagerWorkspace(createViteMounts(this.projectRoot, this.template, options.initialLabel || "alpha"));
  }

  run(): ViteProductWorkflowResult {
    const install = this.install();
    const realCliReadiness = this.inspectRealCliReadiness();
    const devServer = this.startDevServerFromPackageScript();
    const preview = this.preview("/");
    const hmr = this.editMessage("beta");
    const build = this.buildFromPackageScript();
    const reloadRecovery = this.restart();
    return {
      runtime: "browser-guest-node-runtime",
      manager: this.manager,
      template: this.template,
      projectId: this.projectId,
      install,
      realCliReadiness,
      devServer,
      preview,
      hmr,
      build,
      reloadRecovery
    };
  }

  async runCliBacked(): Promise<ViteProductCliBackedWorkflowResult> {
    const install = this.install();
    const realCliReadiness = this.inspectRealCliReadiness();
    const devServer = await this.startDevServerFromCliExecution();
    const preview = this.preview("/");
    const hmr = this.editMessage("beta");
    const build = await this.buildFromCliExecution();
    const reloadRecovery = this.restart();
    return {
      runtime: "browser-guest-node-runtime",
      manager: this.manager,
      template: this.template,
      projectId: this.projectId,
      install,
      realCliReadiness,
      devServer,
      preview,
      hmr,
      build,
      reloadRecovery
    };
  }

  install(): ViteProductInstallResult {
    const packages = packagesForTemplate(this.template);
    for (const pkg of packages) {
      if ((pkg === "vite" && this.vitePackageArtifact) || this.#hasDependencyArtifact(pkg)) continue;
      this.#installFixturePackage(pkg);
    }
    this.#installVitePackage();
    this.#installDependencyArtifacts();
    this.#installEsbuildShim();
    const lockfile = this.manager === "npm" ? "package-lock.json" : this.manager === "yarn" ? "yarn.lock" : "pnpm-lock.yaml";
    this.workspace.writeText(join(this.projectRoot, lockfile), createLockfile(this.manager, packages));
    return {
      installed: true,
      lockfile,
      packages: uniquePackageNames([...packages, ...this.dependencyArtifacts.map((artifact) => artifact.name)]),
      vitePackageSource: this.#vitePackageSource()
    };
  }

  inspectRealCliReadiness(): ViteRealCliReadiness {
    const cliEntrypoint = this.#resolveBin("vite");
    const cliEntryReadiness = inspectCliEntryReadiness({
      entry: {
        name: "vite",
        version: this.#readVitePackageVersion(),
        entry: cliEntrypoint,
        mode: "esm"
      },
      reader: this.workspace,
      supportedModes: ["cjs", "esm"]
    });
    const cliModuleGraph = analyzeCliModuleGraph({
      entry: cliEntrypoint,
      packageRoot: join(this.projectRoot, "node_modules/vite"),
      reader: this.workspace,
      maxModules: 128
    });
    const missingCapabilities = missingCapabilitiesForTemplate(this.template);
    return {
      status: "blocked",
      capabilityStatus: createViteCapabilityStatus({
        cliEntryReadiness,
        cliModuleGraph,
        missingCapabilities,
        vitePackageSource: this.#vitePackageSource()
      }),
      cliEntrypoint,
      cliEntryReadiness,
      cliModuleGraph,
      dependencyMaterializationPlan: createDependencyMaterializationPlan(cliModuleGraph, this.dependencyArtifacts, this.wasmAdapterPolicy),
      missingCapabilities,
      nextAction: "Replace the adapter-backed Vite workflow with vendored Vite CLI/module execution once the listed runtime capabilities are implemented.",
      vitePackageSource: this.#vitePackageSource()
    };
  }

  async executeRealCli(
    args: string[] = ["--host", "127.0.0.1"],
    env: RuntimeEnv = {},
    options: ViteProductCliExecutionOptions = {}
  ): Promise<ViteProductCliExecutionResult> {
    if (!this.workspace.exists(join(this.projectRoot, "node_modules/.bin/vite"))) this.install();
    const cliEntrypoint = this.#resolveBin("vite");
    const buildRegistrations: ViteProductCliBuildRegistration[] = [];
    const hmrRegistrations: ViteProductCliHmrRegistration[] = [];
    const serverRegistrations: ViteProductCliServerRegistration[] = [];
    const transformRegistrations: ViteProductCliTransformRegistration[] = [];
    const isolation = options.isolation || "shared";
    if (isolation === "shared" && isForcedWasiEnv(env) && this.#hasDependencyArtifact("@napi-rs/wasm-runtime")) {
      return {
        args,
        asyncBindingReadinessBlocker: null,
        asyncModuleBlocker: null,
        buildRegistrations,
        cwd: this.projectRoot,
        entry: cliEntrypoint,
        exitCode: 1,
        hmrRegistrations,
        mode: "async-cli-module-evaluation",
        serverRegistrations,
        stderr: "EVITEWASISYNCINIT: forced WASI execution requires isolated worker evaluation before running @napi-rs/wasm-runtime in the browser runtime.\n",
        stdout: "",
        transformRegistrations
      };
    }
    if (isolation === "shared" && this.#hasDependencyArtifact("@napi-rs/wasm-runtime")) {
      return {
        args,
        asyncBindingReadinessBlocker: null,
        asyncModuleBlocker: null,
        buildRegistrations,
        cwd: this.projectRoot,
        entry: cliEntrypoint,
        exitCode: 1,
        hmrRegistrations,
        mode: "async-cli-module-evaluation",
        serverRegistrations,
        stderr: "EVITEWASIISOLATIONREQUIRED: Vite/Rolldown WASI runtime dependencies require snapshot or worker isolation before shared CLI execution.\n",
        stdout: "",
        transformRegistrations
      };
    }
    const broadcastHmr = (update: ViteProductHmrUpdate): ViteProductHmrUpdate => {
      this.#broadcastHmr(update);
      return update;
    };
    const fsTrace: CliEvaluationFsTraceEntry[] = [];
    const evaluatorOptions = {
      ...(options.traceFs ? { fsTrace } : {}),
      ...(options.readyTimeoutMs !== undefined ? { readyTimeoutMs: options.readyTimeoutMs } : {}),
      loopbackNetwork: this.network,
      root: this.projectRoot,
      globals: {
        __viteRegisterBuild(registration: ViteProductCliBuildRegistration) {
          buildRegistrations.push(registration);
        },
        __viteRegisterHmrChannel(registration: ViteProductCliHmrRegistration) {
          hmrRegistrations.push(registration);
        },
        __viteRegisterDevServer(registration: ViteProductCliServerRegistration) {
          serverRegistrations.push(registration);
        },
        __viteRegisterTransform(registration: ViteProductCliTransformRegistration) {
          transformRegistrations.push(registration);
        },
        __viteBroadcastHmr: broadcastHmr
      }
    };
    const request = {
      entry: {
        name: "vite",
        version: this.#readVitePackageVersion(),
        entry: cliEntrypoint,
        mode: "esm"
      },
      args,
      cwd: this.projectRoot,
      env
    };
    if (isolation === "worker" && !options.workerFactory) {
      throw new Error("ERR_VITE_CLI_WORKER_FACTORY_REQUIRED");
    }
    const result = isolation === "worker"
      ? await createWorkerBackedAsyncCliModuleEvaluator({
        root: this.projectRoot,
        captureGlobalCalls: [
          "__viteRegisterBuild",
          "__viteRegisterHmrChannel",
          "__viteRegisterDevServer",
          "__viteRegisterTransform"
        ],
        loopbackNetwork: this.network,
        ...(options.readyTimeoutMs !== undefined ? { readyTimeoutMs: options.readyTimeoutMs } : {}),
        ...(options.traceFs ? { traceFs: true } : {}),
        workerFactory: options.workerFactory!,
        ...(options.workerTimeoutMs !== undefined ? { workerTimeoutMs: options.workerTimeoutMs } : {}),
        workspace: this.workspace
      })(request)
      : isolation === "snapshot"
        ? await createIsolatedAsyncCliModuleEvaluator({
          ...evaluatorOptions,
          workspace: this.workspace
        })(request)
        : await createAsyncCliModuleEvaluator({
          ...evaluatorOptions,
          reader: this.workspace,
          writer: this.workspace
        })(request);
    if (hasCapturedViteGlobalCalls(result)) {
      applyCapturedViteGlobalCalls(result.capturedGlobalCalls, {
        buildRegistrations,
        hmrRegistrations,
        serverRegistrations,
        transformRegistrations,
        broadcastHmr
      });
    }
    return {
      ...result,
      args,
      asyncBindingReadinessBlocker: classifyAsyncBindingReadinessBlocker(result.stderr),
      asyncModuleBlocker: classifyAsyncModuleBlocker(result.stderr),
      buildRegistrations,
      cwd: this.projectRoot,
      ...(options.traceFs && !("fsTrace" in result) ? { fsTrace } : {}),
      hmrRegistrations,
      mode: isolation === "worker"
        ? "worker-backed-cli-module-evaluation"
        : isolation === "snapshot"
          ? "isolated-snapshot-cli-module-evaluation"
          : "async-cli-module-evaluation",
      serverRegistrations,
      transformRegistrations
    };
  }

  startDevServer(): ViteProductDevServerSnapshot {
    if (this.#listener) return this.#snapshot();
    this.#devServerSource = "adapter";
    this.#devServerCommand = "vite --host 127.0.0.1";
    this.#devServerCliEntrypoint = this.#resolveBin("vite");
    this.#listener = this.network.listen(this.#port, async (request) => {
      this.#requests.push(request.path);
      const preview = await this.#previewRequest(request.path);
      return toRuntimeHttpResponse(preview);
    }, {
      websocket: (socket) => {
        this.#attachHmrSocket({
          close: () => socket.close(),
          onmessage: (event) => socket.send(event.data),
          sendMessage: (payload) => socket.send(JSON.stringify(payload))
        });
      }
    });
    this.#devProcess = spawnRuntimeChild({
      pid: this.#port,
      entrypoint: ({ scheduler, stdio }) => {
        stdio.stdout.write(new TextEncoder().encode(`vite dev server listening on 127.0.0.1:${this.#port}\n`));
        scheduler.liveness.ref("vite-dev-server");
      }
    });
    void this.#devProcess.scheduler.drainMicrotasks();
    this.#running = true;
    return this.#snapshot();
  }

  startDevServerFromPackageScript(name = "dev"): ViteProductDevServerSnapshot {
    const command = this.#readScript(name);
    assertViteDevCommand(command);
    const cliEntrypoint = this.#resolveCommandEntrypoint(command);
    this.startDevServer();
    this.#devServerSource = "package-script";
    this.#devServerCommand = command;
    this.#devServerCliEntrypoint = cliEntrypoint;
    this.#moduleTransformSource = "adapter";
    this.#cliHmrSendUpdate = null;
    this.#cliTransformRequest = null;
    return this.#snapshot();
  }

  async startDevServerFromCliExecution(name = "dev", options: ViteProductCliExecutionOptions = {}): Promise<ViteProductDevServerSnapshot> {
    const command = this.#readScript(name);
    assertViteDevCommand(command);
    const cliEntrypoint = this.#resolveCommandEntrypoint(command);
    const args = commandArgs(command);
    try {
      const cliExecution = await this.executeRealCli(args, { PORT: String(this.#port) }, options);
      const registration = cliExecution.serverRegistrations.at(-1);
      if (!registration) {
        if (cliExecution.exitCode !== 0) throw new Error(cliExecution.stderr || "ERR_VITE_CLI_SERVER_REGISTRATION_MISSING");
        this.#port = parseViteReadyPort(cliExecution.stdout) ?? this.#port;
        this.#running = true;
        this.#devServerSource = "cli-execution";
        this.#devServerCommand = command;
        this.#devServerCliEntrypoint = cliEntrypoint;
        this.#moduleTransformSource = "vite-cli";
        return this.#snapshot();
      }
      if (!cliExecution.transformRegistrations.some((item) => item.source === "vite-cli")) {
        throw new Error("ERR_VITE_CLI_TRANSFORM_REGISTRATION_MISSING");
      }
      this.#cliHmrSendUpdate = latestHmrSendUpdate(cliExecution.hmrRegistrations);
      this.#cliTransformRequest = latestTransformRequest(cliExecution.transformRegistrations);
      this.#port = registration.port;
      this.startDevServer();
      this.#devServerSource = "cli-execution";
      this.#devServerCommand = command;
      this.#devServerCliEntrypoint = cliEntrypoint;
      this.#moduleTransformSource = "vite-cli";
      return this.#snapshot();
    } catch (error) {
      // Timed-out or crashed CLI workers must not leave a half-open preview session.
      this.stopDevServer();
      this.#cliHmrSendUpdate = null;
      this.#cliTransformRequest = null;
      throw error;
    }
  }

  stopDevServer(): ViteProductDevServerSnapshot {
    this.#listener?.close();
    this.#listener = null;
    this.#running = false;
    this.#devProcess?.process.exit(143);
    return this.#snapshot();
  }

  preview(path = "/"): ViteProductPreviewResult {
    if (!this.#running) return { statusCode: 503, body: "dev server unavailable" };
    const requestPath = path.split("?")[0] || "/";
    if (requestPath === "/@vite/client") {
      return {
        statusCode: 200,
        headers: { "content-type": "text/javascript; charset=utf-8" },
        body: "export const createHotContext = () => ({ accept() {}, on() {}, dispose() {} });\nexport function updateStyle() {}\nexport function removeStyle() {}\n"
      };
    }
    if (requestPath === "/" || requestPath === "/index.html") {
      return {
        statusCode: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
        body: this.#renderPreviewHtml()
      };
    }
    const source = this.#readServedSource(requestPath);
    if (source) return source;
    return { statusCode: 404, body: "Not found" };
  }

  async #previewRequest(path = "/"): Promise<ViteProductPreviewResult> {
    if (!this.#running) return { statusCode: 503, body: "dev server unavailable" };
    const requestPath = path.split("?")[0] || "/";
    if (requestPath === "/@vite/client") return this.preview(requestPath);
    if (requestPath !== "/" && requestPath !== "/index.html") {
      const source = await this.#readServedSourceAsync(requestPath);
      if (source) return source;
      return { statusCode: 404, body: "Not found" };
    }
    return this.preview(requestPath);
  }

  async fetch(input: string | URL, options: LoopbackFetchOptions = {}): Promise<Response> {
    const response = await this.network.fetch(input, options);
    const init: ResponseInit = { status: response.statusCode };
    if (response.statusText) init.statusText = response.statusText;
    if (response.headers) init.headers = response.headers;
    return new Response(toResponseBody(response.body), init);
  }

  editMessage(label: string): ViteProductHmrResult {
    const relative = ["src/message.js", "src/message.ts", "src/message.jsx", "src/message.tsx"]
      .find((path) => this.workspace.exists(join(this.projectRoot, path)))
      || "src/message.js";
    return this.applySourceEdit(relative, `export const label = "${label}";\n`);
  }

  applySourceEdit(path: string, data: string): ViteProductSourceEditResult {
    const requestPath = normalizeServedPath(path);
    const before = previewBodyText(this.preview("/").body);
    this.workspace.writeText(join(this.projectRoot, requestPath), data);
    const after = previewBodyText(this.preview("/").body);
    const update = createViteHmrUpdate(requestPath, hmrLabelForSource(requestPath, data));
    this.#hmrUpdates.push(update);
    this.#sendHmrUpdate(update);
    return {
      before,
      after,
      path: requestPath,
      update,
      statePreserved: before.includes(`:${this.#state.count}`) && after.includes(`:${this.#state.count}`)
    };
  }

  hmrUpdates(): ViteProductHmrUpdate[] {
    return [...this.#hmrUpdates];
  }

  connectHmr(): ViteProductHmrSocket {
    const socket: ViteProductHmrSocket = {
      close: () => {
        this.#hmrSockets.delete(socket);
        socket.onclose?.();
      },
      sendMessage: (payload) => {
        socket.onmessage?.({ data: JSON.stringify(payload) });
      }
    };
    this.#attachHmrSocket(socket);
    return socket;
  }

  #attachHmrSocket(socket: ViteProductHmrSocket): void {
    this.#hmrSockets.add(socket);
    queueMicrotask(() => {
      if (this.#hmrSockets.has(socket)) socket.onmessage?.({ data: JSON.stringify({ type: "connected" }) });
    });
  }

  build(): ViteProductBuildResult {
    const html = renderHtml(this.#readLabel(), this.#state.count);
    this.workspace.writeText(join(this.projectRoot, "dist/index.html"), html);
    this.workspace.writeText(join(this.projectRoot, "dist/assets/index.js"), `document.querySelector("#app").textContent = "${this.#readLabel()}:${this.#state.count}";\n`);
    return {
      files: ["dist/index.html", "dist/assets/index.js"],
      distSmoke: this.workspace.readText(join(this.projectRoot, "dist/index.html")),
      command: this.#buildCommand,
      cliEntrypoint: this.#buildCliEntrypoint
    };
  }

  buildFromPackageScript(name = "build"): ViteProductBuildResult {
    const command = this.#readScript(name);
    assertViteBuildCommand(command);
    this.#buildCommand = command;
    this.#buildCliEntrypoint = this.#resolveCommandEntrypoint(command);
    return this.build();
  }

  async buildFromCliExecution(name = "build"): Promise<ViteProductBuildResult> {
    const command = this.#readScript(name);
    assertViteBuildCommand(command);
    const cliEntrypoint = this.#resolveCommandEntrypoint(command);
    const cliExecution = await this.executeRealCli(commandArgs(command));
    if (!cliExecution.buildRegistrations.some((registration) => registration.command === "build")) {
      throw new Error("ERR_VITE_CLI_BUILD_REGISTRATION_MISSING");
    }
    this.#buildCommand = command;
    this.#buildCliEntrypoint = cliEntrypoint;
    return this.build();
  }

  restart(): ViteProductReloadRecoveryResult {
    const command = this.#devServerCommand;
    const source = this.#devServerSource;
    const cliEntrypoint = this.#devServerCliEntrypoint;
    this.stopDevServer();
    this.#restartCount += 1;
    this.startDevServer();
    this.#devServerCommand = command;
    this.#devServerSource = source;
    this.#devServerCliEntrypoint = cliEntrypoint;
    return {
      restarted: true,
      previewAfterRestart: previewBodyText(this.preview("/").body)
    };
  }

  #snapshot(): ViteProductDevServerSnapshot {
    return {
      moduleTransform: this.#moduleTransformSource,
      port: this.#port,
      running: this.#running,
      restartCount: this.#restartCount,
      requests: [...this.#requests],
      command: this.#devServerCommand,
      source: this.#devServerSource,
      cliEntrypoint: this.#devServerCliEntrypoint,
      processPid: this.#devProcess?.process.pid ?? null,
      processStarted: this.#devProcess?.started ?? false,
      processExited: this.#devProcess?.process.exited ?? false
    };
  }

  #readLabel(): string {
    for (const relative of ["src/message.js", "src/message.ts", "src/message.jsx", "src/message.tsx"]) {
      const path = join(this.projectRoot, relative);
      if (!this.workspace.exists(path)) continue;
      const source = this.workspace.readText(path);
      return source.match(/label\s*=\s*"([^"]+)"/)?.[1] || "unknown";
    }
    return "unknown";
  }

  #readScript(name: string): string {
    const manifest = JSON.parse(this.workspace.readText(join(this.projectRoot, "package.json"))) as { scripts?: Record<string, string> };
    const command = manifest.scripts?.[name];
    if (!command) throw new Error(`missing package script: ${name}`);
    return command;
  }

  #resolveServedWorkspacePath(requestPath: string): string | null {
    const direct = join(this.projectRoot, requestPath);
    if (this.workspace.exists(direct)) return direct;
    if (requestPath.endsWith(".js")) {
      for (const extension of [".ts", ".tsx", ".jsx", ".mjs"]) {
        const candidate = join(this.projectRoot, `${requestPath.slice(0, -3)}${extension}`);
        if (this.workspace.exists(candidate)) return candidate;
      }
    }
    return null;
  }

  #readServedSource(requestPath: string): ViteProductPreviewResult | null {
    const workspacePath = this.#resolveServedWorkspacePath(requestPath);
    if (!workspacePath) return null;
    const contentType = contentTypeForPath(requestPath);
    const bytes = this.workspace.readBytes(workspacePath);
    const body = decodePreviewText(bytes);
    if (body === null) return { statusCode: 200, headers: { "content-type": contentType }, body: bytes };
    const transformPath = workspacePath.slice(this.projectRoot.length) || requestPath;
    return {
      statusCode: 200,
      headers: { "content-type": contentTypeForPath(requestPath) },
      body: transformViteModuleSource(transformPath, body, this.#moduleTransformSource)
    };
  }

  async #readServedSourceAsync(requestPath: string): Promise<ViteProductPreviewResult | null> {
    const workspacePath = this.#resolveServedWorkspacePath(requestPath);
    if (!workspacePath) return null;
    const contentType = contentTypeForPath(requestPath);
    const bytes = this.workspace.readBytes(workspacePath);
    const body = decodePreviewText(bytes);
    if (body === null) return { statusCode: 200, headers: { "content-type": contentType }, body: bytes };
    const transformPath = workspacePath.slice(this.projectRoot.length) || requestPath;
    return {
      statusCode: 200,
      headers: { "content-type": contentTypeForPath(requestPath) },
      body: await this.#transformServedSource(transformPath, body)
    };
  }

  async #transformServedSource(requestPath: string, source: string): Promise<string> {
    if (this.#moduleTransformSource === "vite-cli" && this.#cliTransformRequest) {
      const transformed = await this.#cliTransformRequest({ path: requestPath, source });
      return typeof transformed === "string" ? transformed : transformed.code;
    }
    return transformViteModuleSource(requestPath, source, this.#moduleTransformSource);
  }

  #renderPreviewHtml(): string {
    const label = this.#readLabel();
    const count = this.#state.count;
    const indexPath = join(this.projectRoot, "index.html");
    const importMap = JSON.stringify({
      imports: {
        react: "./node_modules/react/index.js",
        "react-dom": "./node_modules/react-dom/client.js",
        "react-dom/client": "./node_modules/react-dom/client.js",
        "react/jsx-runtime": "./node_modules/react/jsx-runtime.js",
        "react/jsx-dev-runtime": "./node_modules/react/jsx-runtime.js"
      }
    });
    const styleLink = this.workspace.exists(join(this.projectRoot, "src/style.css"))
      ? '<link rel="stylesheet" href="./src/style.css" />'
      : "";
    const bootstrap = this.#previewEntryScript();

    if (this.workspace.exists(indexPath)) {
      let html = this.workspace.readText(indexPath);
      html = html.replace(/(src|href)=["']\/(?!\/)/g, '$1="./');
      if (!/<script\s+type=["']importmap["']/.test(html)) {
        html = html.replace(
          /<head([^>]*)>/i,
          `<head$1><script type="importmap">${importMap}</script>${styleLink}`
        );
        if (!/<head[^>]*>/i.test(html)) {
          html = `<!doctype html><html><head><script type="importmap">${importMap}</script>${styleLink}</head><body>${html.replace(/^<!doctype html>/i, "")}</body></html>`;
        }
      }
      // Keep a static smoke label in #app/#root so relay/HTML assertions and first paint work,
      // then let the real entry module replace it.
      if (!/id=["']app["']/.test(html) && !/id=["']root["']/.test(html)) {
        html = html.replace(/<body([^>]*)>/i, `<body$1><div id="app">${label}:${count}</div>`);
      } else {
        html = html.replace(
          /(<div[^>]*id=["'](?:app|root)["'][^>]*>)(.*?)(<\/div>)/i,
          `$1${label}:${count}$3`
        );
      }
      if (bootstrap && !new RegExp(bootstrap.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).test(html)) {
        html = html.replace(/<\/body>/i, `<script type="module" src="${bootstrap}"></script></body>`);
        if (!/<\/body>/i.test(html)) html += `<script type="module" src="${bootstrap}"></script>`;
      }
      return html;
    }

    return [
      "<!doctype html>",
      "<html><head>",
      `<script type="importmap">${importMap}</script>`,
      styleLink,
      "</head><body>",
      `<div id="app">${label}:${count}</div>`,
      bootstrap ? `<script type="module" src="${bootstrap}"></script>` : "",
      "</body></html>"
    ].join("");
  }

  #previewEntryScript(): string | null {
    const candidates = [
      "src/main.tsx",
      "src/main.jsx",
      "src/main.ts",
      "src/main.js",
      "src/App.tsx",
      "src/App.jsx",
      "src/App.svelte"
    ];
    for (const candidate of candidates) {
      if (this.workspace.exists(join(this.projectRoot, candidate))) return `./${candidate}`;
    }
    return null;
  }

  #installVitePackage(): void {
    if (this.vitePackageArtifact) {
      this.#installVitePackageArtifact(this.vitePackageArtifact);
      return;
    }
    this.#installViteCliEntrypoint();
  }

  #installVitePackageArtifact(artifact: ViteProductPackageArtifact): void {
    const packageRoot = join(this.projectRoot, "node_modules/vite");
    for (const mount of artifact.mounts) {
      this.#writePackageMount(join(packageRoot, normalizePackageArtifactPath(mount.path)), mount);
    }
    const packageJsonPath = join(packageRoot, "package.json");
    if (!this.workspace.exists(packageJsonPath)) {
      throw new ViteProductPackageArtifactError("EVITEARTIFACTMANIFEST", "Mounted Vite package artifact must include package.json.", packageJsonPath);
    }
    const manifest = this.#readVitePackageManifest();
    if (manifest.name !== "vite") {
      throw new ViteProductPackageArtifactError("EVITEARTIFACTNAME", "Mounted Vite package artifact package.json must have name \"vite\".", packageJsonPath);
    }
    const binPath = join(packageRoot, readVitePackageBinPath(manifest));
    if (!this.workspace.exists(binPath)) {
      throw new ViteProductPackageArtifactError("EVITEARTIFACTBIN", "Mounted Vite package artifact bin entry is missing.", binPath);
    }
    this.workspace.symlink(binPath, join(this.projectRoot, "node_modules/.bin/vite"));
  }

  #installFixturePackage(pkg: string): void {
    const packageRoot = join(this.projectRoot, "node_modules", pkg);
    if (pkg === "react") {
      this.workspace.writeText(join(packageRoot, "package.json"), JSON.stringify({
        name: "react",
        version: "18.3.1",
        type: "module",
        exports: {
          ".": "./index.js",
          "./jsx-runtime": "./jsx-runtime.js",
          "./jsx-dev-runtime": "./jsx-runtime.js"
        }
      }));
      this.workspace.writeText(join(packageRoot, "index.js"), [
        "const Fragment = Symbol.for('react.fragment');",
        "let hookCursor = 0;",
        "let hookStates = [];",
        "let scheduleRerender = null;",
        "export function resetHooks() { hookCursor = 0; }",
        "export function bindScheduler(fn) { scheduleRerender = fn; }",
        "function createElement(type, props, ...children) {",
        "  const flat = children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false);",
        "  return { $$typeof: 'element', type, props: props || {}, children: flat };",
        "}",
        "function StrictMode(props) { return props.children; }",
        "function useState(initial) {",
        "  const index = hookCursor++;",
        "  if (hookStates[index] === undefined) hookStates[index] = typeof initial === 'function' ? initial() : initial;",
        "  const setState = (update) => {",
        "    const previous = hookStates[index];",
        "    hookStates[index] = typeof update === 'function' ? update(previous) : update;",
        "    scheduleRerender && scheduleRerender();",
        "  };",
        "  return [hookStates[index], setState];",
        "}",
        "export { Fragment, createElement, StrictMode, useState };",
        "export default { Fragment, createElement, StrictMode, useState };",
        ""
      ].join("\n"));
      this.workspace.writeText(join(packageRoot, "jsx-runtime.js"), [
        "import { createElement, Fragment } from './index.js';",
        "export function jsx(type, props, key) {",
        "  const { children, ...rest } = props || {};",
        "  const next = key === undefined ? rest : { ...rest, key };",
        "  return createElement(type, next, ...(Array.isArray(children) ? children : children === undefined ? [] : [children]));",
        "}",
        "export const jsxs = jsx;",
        "export { Fragment };",
        ""
      ].join("\n"));
      return;
    }
    if (pkg === "react-dom") {
      this.workspace.writeText(join(packageRoot, "package.json"), JSON.stringify({
        name: "react-dom",
        version: "18.3.1",
        type: "module",
        exports: {
          ".": "./client.js",
          "./client": "./client.js"
        }
      }));
      this.workspace.writeText(join(packageRoot, "client.js"), [
        "import { Fragment, resetHooks, bindScheduler } from '../react/index.js';",
        "function renderNode(value) {",
        "  if (value == null || value === false) return [];",
        "  if (typeof value === 'string' || typeof value === 'number') return [document.createTextNode(String(value))];",
        "  if (Array.isArray(value)) return value.flatMap(renderNode);",
        "  if (typeof value.type === 'function') {",
        "    const props = { ...(value.props || {}) };",
        "    if (value.children?.length) props.children = value.children.length === 1 ? value.children[0] : value.children;",
        "    return renderNode(value.type(props));",
        "  }",
        "  if (value.type === Fragment) return (value.children || []).flatMap(renderNode);",
        "  const el = document.createElement(value.type);",
        "  const props = value.props || {};",
        "  for (const [key, raw] of Object.entries(props)) {",
        "    if (key === 'children' || raw == null || raw === false) continue;",
        "    if (key === 'className') el.setAttribute('class', String(raw));",
        "    else if (key === 'style' && typeof raw === 'object') Object.assign(el.style, raw);",
        "    else if (key.startsWith('on') && typeof raw === 'function') el.addEventListener(key.slice(2).toLowerCase(), raw);",
        "    else el.setAttribute(key, String(raw));",
        "  }",
        "  const kids = props.children !== undefined ? props.children : value.children;",
        "  for (const child of renderNode(kids || [])) el.appendChild(child);",
        "  return [el];",
        "}",
        "export function createRoot(target) {",
        "  let element = null;",
        "  const mount = () => {",
        "    if (!target || !element) return;",
        "    resetHooks();",
        "    if (typeof element === 'string' || typeof element === 'number') {",
        "      target.textContent = String(element);",
        "      return;",
        "    }",
        "    target.replaceChildren(...renderNode(element));",
        "  };",
        "  bindScheduler(mount);",
        "  return {",
        "    render(value) {",
        "      element = value;",
        "      mount();",
        "    }",
        "  };",
        "}",
        ""
      ].join("\n"));
      return;
    }
    if (pkg === "@vitejs/plugin-react" || pkg === "@vitejs/plugin-react-swc") {
      this.workspace.writeText(join(packageRoot, "package.json"), JSON.stringify({
        name: pkg,
        version: "latest",
        type: "module",
        exports: {
          ".": "./index.js"
        }
      }));
      this.workspace.writeText(join(packageRoot, "index.js"), "export default function react() { return { name: 'browser-native-react-plugin' }; }\n");
      return;
    }
    this.workspace.writeText(join(packageRoot, "package.json"), JSON.stringify({ name: pkg }));
  }

  #installEsbuildShim(): void {
    if (this.workspace.exists(join(this.projectRoot, "node_modules/esbuild/package.json"))) return;
    const packageRoot = join(this.projectRoot, "node_modules/esbuild");
    this.workspace.writeText(join(packageRoot, "package.json"), JSON.stringify({
      name: "esbuild",
      version: "browser-native-shim",
      type: "module",
      exports: {
        ".": "./index.js"
      }
    }));
    this.workspace.writeText(join(packageRoot, "index.js"), [
      "export async function initialize() {}",
      "export async function formatMessages(messages = []) { return messages.map((message) => message?.text || String(message)); }",
      "export async function transform(source, options = {}) {",
      "  return { code: transformSource(String(source), options), map: null, warnings: [] };",
      "}",
      "function transformSource(source, options) {",
      "  const loader = options.loader || '';",
      "  if (loader === 'jsx' || loader === 'tsx' || /<[A-Za-z][\\s\\S]*>/.test(source)) return transformJsxModule(source);",
      "  return source;",
      "}",
      "function transformJsxModule(source) {",
      "  const imports = source.split('\\n').filter((line) => {",
      "    const text = line.trim();",
      "    if (!text.startsWith('import ')) return false;",
      "    return !/\\.(?:css|png|jpe?g|gif|svg|webp)(?:['\\\"]|$)/.test(text);",
      "  }).join('\\n');",
      "  if (/export\\s+default|function\\s+App\\b/.test(source)) return `${imports}\\nfunction App() { return null; }\\nexport default App;\\n`;",
      "  return `${imports}\\nexport {};\\n`;",
      "}",
      "export const version = 'browser-native-shim';",
      ""
    ].join("\n"));
  }

  #installDependencyArtifacts(): void {
    for (const artifact of this.dependencyArtifacts) {
      const packageRoot = join(this.projectRoot, "node_modules", artifact.name);
      for (const mount of artifact.mounts) {
        this.#writePackageMount(join(packageRoot, normalizePackageArtifactPath(mount.path)), mount);
      }
      const packageJsonPath = join(packageRoot, "package.json");
      if (!this.workspace.exists(packageJsonPath)) {
        throw new ViteProductPackageArtifactError("EVITEARTIFACTMANIFEST", `Mounted dependency artifact ${artifact.name} must include package.json.`, packageJsonPath);
      }
      const manifest = JSON.parse(this.workspace.readText(packageJsonPath)) as VitePackageManifest;
      if (manifest.name !== artifact.name && !isPackageAliasName(artifact.name, manifest.name)) {
        throw new ViteProductPackageArtifactError(
          "EVITEARTIFACTNAME",
          `Mounted dependency artifact package.json must have name "${artifact.name}".`,
          packageJsonPath
        );
      }
    }
  }

  #hasDependencyArtifact(name: string): boolean {
    return this.dependencyArtifacts.some((artifact) => artifact.name === name);
  }

  #writePackageMount(path: string, mount: PackageManagerWorkspaceMount): void {
    if (mount.encoding === "base64") {
      this.workspace.writeBytes(path, decodeBase64(mount.data));
      return;
    }
    this.workspace.writeText(path, mount.data);
  }

  #installViteCliEntrypoint(): void {
    const packageJsonPath = join(this.projectRoot, "node_modules/vite/package.json");
    this.workspace.writeText(packageJsonPath, JSON.stringify({ name: "vite", version: "8.2.0", type: "module", bin: { vite: "bin/vite.js" } }));
    this.workspace.writeText(join(this.projectRoot, "node_modules/vite/bin/vite.js"), "#!/usr/bin/env node\nimport '../dist/node/cli.js';\n");
    this.workspace.writeText(
      join(this.projectRoot, "node_modules/vite/dist/node/cli.js"),
      "import { createRequire } from 'node:module';\nimport { runBuild } from './build.js';\nimport { startDevServer } from './server.js';\nconst require = createRequire(import.meta.url);\nrequire('../../package.json');\nif (process.argv.includes('build')) {\n  runBuild({ outDir: 'dist' });\n} else {\n  startDevServer({ host: '127.0.0.1', port: Number(process.env.PORT || 5173) });\n}\n"
    );
    this.workspace.writeText(
      join(this.projectRoot, "node_modules/vite/dist/node/build.js"),
      "export function runBuild(options) {\n  global.__viteRegisterBuild?.({ command: 'build', outDir: options.outDir, source: 'vite-cli' });\n}\n"
    );
    this.workspace.writeText(
      join(this.projectRoot, "node_modules/vite/dist/node/server.js"),
      "import { EventEmitter } from 'node:events';\nimport { createHotChannel } from './hmr.js';\nimport { registerTransform } from './transform.js';\nexport function startDevServer(options) {\n  const server = new EventEmitter();\n  registerTransform();\n  createHotChannel(server);\n  global.__viteRegisterDevServer?.({ command: 'dev', host: options.host, port: options.port, source: 'vite-cli' });\n  return server;\n}\n"
    );
    this.workspace.writeText(
      join(this.projectRoot, "node_modules/vite/dist/node/hmr.js"),
      "export function createHotChannel(server) {\n  server.emit('vite:hmr-ready');\n  const channel = { send(update) { global.__viteBroadcastHmr?.(update); return update; } };\n  global.__viteRegisterHmrChannel?.({ channel: 'hmr', source: 'vite-cli', transport: 'loopback', sendUpdate: channel.send });\n  return channel;\n}\n"
    );
    this.workspace.writeText(
      join(this.projectRoot, "node_modules/vite/dist/node/transform.js"),
      "export function registerTransform() {\n  global.__viteRegisterTransform?.({ mode: 'browser-esm', source: 'vite-cli', transformRequest(request) { return { code: `// transformed by vite-cli service:${request.path}\\n${request.source}` }; } });\n}\n"
    );
    this.workspace.symlink(join(this.projectRoot, "node_modules/vite/bin/vite.js"), join(this.projectRoot, "node_modules/.bin/vite"));
  }

  #readVitePackageVersion(): string {
    const manifest = this.#readVitePackageManifest();
    return manifest.version || this.vitePackageArtifact?.version || "8.2.0";
  }

  #readVitePackageManifest(): VitePackageManifest {
    return JSON.parse(this.workspace.readText(join(this.projectRoot, "node_modules/vite/package.json"))) as VitePackageManifest;
  }

  #vitePackageSource(): ViteProductPackageSource {
    return this.vitePackageArtifact ? "mounted-artifact" : "stub";
  }

  #resolveCommandEntrypoint(command: string): string {
    const [binary] = command.split(/\s+/);
    if (!binary) throw new Error(`missing command binary: ${command}`);
    return this.#resolveBin(binary);
  }

  #resolveBin(binary: string): string {
    const binPath = join(this.projectRoot, "node_modules/.bin", binary);
    if (!this.workspace.exists(binPath)) throw new Error(`missing package bin: ${binary}`);
    return this.workspace.readlink(binPath);
  }

  #broadcastHmr(payload: ViteProductHmrUpdate): void {
    for (const socket of this.#hmrSockets) {
      socket.onmessage?.({ data: JSON.stringify(payload) });
    }
  }

  #sendHmrUpdate(payload: ViteProductHmrUpdate): void {
    if (this.#cliHmrSendUpdate) {
      void this.#cliHmrSendUpdate(payload);
      return;
    }
    this.#broadcastHmr(payload);
  }
}

export function runViteProductWorkflow(options: ViteProductWorkflowOptions): ViteProductWorkflowResult {
  return new ViteProductWorkflow(options).run();
}

export function runViteProductCliBackedWorkflow(options: ViteProductWorkflowOptions): Promise<ViteProductCliBackedWorkflowResult> {
  return new ViteProductWorkflow(options).runCliBacked();
}

export const ViteReactProductWorkflow = ViteProductWorkflow;

export function createViteDependencyArtifactClosureFromWorkspace(
  options: ViteProductDependencyArtifactClosureOptions
): ViteProductDependencyArtifactClosureResult {
  const nodeModulesRoot = normalizeServedPath(options.nodeModulesRoot).replace(/\/$/, "");
  const maxIterations = options.maxIterations ?? 8;
  let artifacts = options.initialArtifacts || [];
  const iterations: ViteProductDependencyArtifactClosureIteration[] = [];
  let remainingPlan = inspectDependencyMaterializationPlan(options, artifacts);

  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    const planNames = remainingPlan.missing
      .filter((item) => item.kind !== "native-hold")
      .flatMap((item) => item.artifactNames);
    const manifestDependencyNames = dependencyNamesFromArtifacts(artifacts);
    const extractableNames = uniquePackageNames([...planNames, ...manifestDependencyNames])
      .filter((name) => !artifacts.some((artifact) => artifact.name === name))
      .filter((name) => readerExists(options.reader, join(nodeModulesRoot, name, "package.json")))
      .sort((left, right) => left.localeCompare(right));
    if (extractableNames.length === 0) break;

    const extracted = createViteDependencyArtifactsFromWorkspace({
      names: extractableNames,
      nodeModulesRoot,
      reader: options.reader
    });
    artifacts = mergeViteDependencyArtifacts(artifacts, extracted).artifacts;
    remainingPlan = inspectDependencyMaterializationPlan(options, artifacts);
    iterations.push({
      extracted: extracted.map((artifact) => artifact.name),
      plan: remainingPlan
    });
  }

  return {
    artifacts,
    iterations,
    remainingPlan
  };
}

function dependencyNamesFromArtifacts(artifacts: readonly ViteProductDependencyArtifact[]): string[] {
  return uniquePackageNames(artifacts.flatMap((artifact) => {
    const packageJsonMount = artifact.mounts.find((mount) => mount.path === "package.json");
    if (!packageJsonMount) return [];
    try {
      const manifest = JSON.parse(packageJsonMount.data) as VitePackageManifest;
      return Object.keys(manifest.dependencies || {});
    } catch {
      return [];
    }
  }));
}

export function runViteReactProductWorkflow(options: ViteProductWorkflowOptions): ViteProductWorkflowResult {
  return runViteProductWorkflow({ ...options, template: options.template || "react" });
}

export function runViteReactCliBackedWorkflow(options: ViteProductWorkflowOptions): Promise<ViteProductCliBackedWorkflowResult> {
  return runViteProductCliBackedWorkflow({ ...options, template: options.template || "react" });
}

export function createViteHmrUpdate(path: string, label: string, timestamp = Date.now()): ViteProductHmrUpdate {
  return {
    type: "update",
    updates: [
      {
        type: path.endsWith(".css") ? "css-update" : "js-update",
        path,
        acceptedPath: path,
        timestamp,
        explicitImportRequired: false,
        ssrInvalidates: [],
        label
      }
    ]
  };
}

export type ViteReactPackageManager = ViteProductPackageManager;
export type ViteReactCliBackedWorkflowResult = ViteProductCliBackedWorkflowResult;
export type ViteReactProductWorkflowOptions = ViteProductWorkflowOptions;
export type ViteReactProductWorkflowResult = ViteProductWorkflowResult;
export type ViteReactCliBuildRegistration = ViteProductCliBuildRegistration;
export type ViteReactCliExecutionResult = ViteProductCliExecutionResult;
export type ViteReactCliHmrRegistration = ViteProductCliHmrRegistration;
export type ViteReactCliServerRegistration = ViteProductCliServerRegistration;
export type ViteReactCliTransformRegistration = ViteProductCliTransformRegistration;
export type ViteReactDevServerSource = ViteProductDevServerSource;
export type ViteReactModuleTransformSource = ViteProductModuleTransformSource;
export type ViteReactInstallResult = ViteProductInstallResult;
export type ViteReactDevServerSnapshot = ViteProductDevServerSnapshot;
export type ViteReactHmrUpdate = ViteProductHmrUpdate;
export type ViteReactPreviewResult = ViteProductPreviewResult;
export type ViteReactHmrResult = ViteProductHmrResult;
export type ViteReactSourceEditResult = ViteProductSourceEditResult;
export type ViteReactBuildResult = ViteProductBuildResult;
export type ViteReactReloadRecoveryResult = ViteProductReloadRecoveryResult;

function createViteMounts(projectRoot: string, template: ViteProductTemplate, label: string): PackageManagerWorkspaceMount[] {
  const entry = template === "react"
    ? "./src/main.jsx"
    : template === "vanilla"
      ? "./src/main.js"
      : "./src/main.js";
  const messagePath = template === "vanilla" ? "src/message.js" : "src/message.js";
  return [
    {
      path: join(projectRoot, "package.json"),
      data: JSON.stringify({
        name: `vite-${template}-product-workflow`,
        version: "1.0.0",
        private: true,
        type: "module",
        scripts: {
          dev: "vite --host 127.0.0.1",
          build: "vite build",
          preview: "vite preview --host 127.0.0.1"
        },
        dependencies: {
          vite: "8.2.0",
          ...(template === "vanilla" ? {} : { typescript: "6.0.3" }),
          ...dependenciesForTemplate(template)
        }
      })
    },
    {
      path: join(projectRoot, "index.html"),
      data: `<!doctype html><html><head><meta charset="UTF-8" /></head><body><div id="app"></div><script type="module" src="${entry}"></script></body></html>\n`
    },
    ...sourceMountsForTemplate(projectRoot, template),
    {
      path: join(projectRoot, messagePath),
      data: `export const label = "${label}";\n`
    },
    {
      path: join(projectRoot, "src/style.css"),
      data: "body { margin: 0; font-family: system-ui, sans-serif; }\n#app { padding: 1rem; }\n"
    }
  ];
}

function createLockfile(manager: ViteProductPackageManager, packages: string[]): string {
  if (manager === "npm") {
    return JSON.stringify({
      lockfileVersion: 3,
      packages: Object.fromEntries(packages.map((pkg) => [`node_modules/${pkg}`, { version: "product-fixture" }]))
    });
  }
  if (manager === "yarn") {
    return [
      "# yarn lockfile v1",
      ...packages.flatMap((pkg) => [`${pkg}@product-fixture:`, "  version \"product-fixture\""])
    ].join("\n") + "\n";
  }
  return [
    "lockfileVersion: '9.0'",
    "importers:",
    "  .:",
    "    dependencies:",
    ...packages.map((pkg) => `      ${pkg}: product-fixture`)
  ].join("\n") + "\n";
}

function packagesForTemplate(template: ViteProductTemplate): string[] {
  const base = template === "vanilla" ? ["vite"] : ["vite", "typescript"];
  return [...base, ...Object.keys(dependenciesForTemplate(template))];
}

function uniquePackageNames(packages: string[]): string[] {
  return [...new Set(packages)];
}

function hasCapturedViteGlobalCalls(result: CliRunResult): result is CliRunResult & { capturedGlobalCalls: CliEvaluationCapturedGlobalCall[] } {
  return "capturedGlobalCalls" in result && Array.isArray(result.capturedGlobalCalls);
}

function applyCapturedViteGlobalCalls(
  calls: readonly CliEvaluationCapturedGlobalCall[],
  target: {
    buildRegistrations: ViteProductCliBuildRegistration[];
    hmrRegistrations: ViteProductCliHmrRegistration[];
    serverRegistrations: ViteProductCliServerRegistration[];
    transformRegistrations: ViteProductCliTransformRegistration[];
    broadcastHmr: (update: ViteProductHmrUpdate) => ViteProductHmrUpdate;
  }
): void {
  for (const call of calls) {
    const registration = call.args[0];
    if (!isObjectRecord(registration)) continue;
    if (call.name === "__viteRegisterBuild") {
      target.buildRegistrations.push({
        command: "build",
        outDir: typeof registration.outDir === "string" ? registration.outDir : "dist",
        source: "vite-cli"
      });
    } else if (call.name === "__viteRegisterDevServer") {
      target.serverRegistrations.push({
        command: "dev",
        host: typeof registration.host === "string" ? registration.host : "127.0.0.1",
        port: typeof registration.port === "number" ? registration.port : 5173,
        source: "vite-cli"
      });
    } else if (call.name === "__viteRegisterHmrChannel") {
      target.hmrRegistrations.push({
        channel: "hmr",
        source: "vite-cli",
        transport: "loopback",
        ...(registration.sendUpdate ? { sendUpdate: (update: ViteProductHmrUpdate) => target.broadcastHmr(update) } : {})
      });
    } else if (call.name === "__viteRegisterTransform") {
      target.transformRegistrations.push({
        mode: "browser-esm",
        source: "vite-cli",
        ...(registration.transformRequest
          ? {
            transformRequest(request: ViteProductCliTransformRequestInput): ViteProductCliTransformResult {
              return { code: `// worker proxy transform:${request.path}\n${request.source}` };
            }
          }
          : {})
      });
    }
  }
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isForcedWasiEnv(env: RuntimeEnv): boolean {
  return env.NAPI_RS_FORCE_WASI === "error" || env.NAPI_RS_FORCE_WASI === "true";
}

function classifyAsyncModuleBlocker(stderr: string): ViteProductAsyncModuleBlocker | null {
  const match = stderr.match(/ERR_REQUIRE_ASYNC_MODULE: ([^\n]+)/);
  if (!match?.[1]) return null;
  return {
    module: match[1],
    reason: "sync-require-of-async-esm"
  };
}

function classifyAsyncBindingReadinessBlocker(stderr: string): ViteProductAsyncBindingReadinessBlocker | null {
  if (!stderr.includes("Class extends value undefined is not a constructor or null")) return null;
  return {
    reason: "async-binding-namespace-not-ready"
  };
}

function createDependencyMaterializationPlan(
  graph: CliModuleGraph,
  dependencyArtifacts: readonly ViteProductDependencyArtifact[],
  wasmAdapterPolicy: WasmAdapterPolicy | null
): ViteDependencyMaterializationPlan {
  const satisfied = uniquePackageNames(dependencyArtifacts.map((artifact) => artifact.name)).sort();
  const satisfiedSet = new Set(satisfied);
  const missingSpecifiersByPackage = new Map<string, Set<string>>();
  for (const issue of graph.issues) {
    if (issue.kind !== "missing-module") continue;
    const packageName = packageNameFromSpecifier(issue.specifier);
    if (!packageName || packageName === "vite" || satisfiedSet.has(packageName)) continue;
    const specifiers = missingSpecifiersByPackage.get(packageName) || new Set<string>();
    specifiers.add(issue.specifier);
    missingSpecifiersByPackage.set(packageName, specifiers);
  }
  const missing = [...missingSpecifiersByPackage.entries()]
    .map(([name, specifiers]) => ({
      artifactNames: artifactNamesForDependency(name, wasmAdapterPolicy),
      kind: classifyDependencyMaterialization(name, wasmAdapterPolicy),
      name,
      nextAction: nextActionForDependencyMaterialization(name, wasmAdapterPolicy),
      specifiers: [...specifiers].sort(),
      ...wasmReplacementForDependency(name, wasmAdapterPolicy)
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
  const optional = graph.issues
    .filter((issue): issue is CliModuleGraphIssue & { kind: ViteDependencyMaterializationOptionalKind } => issue.kind.startsWith("optional-"))
    .map((issue) => ({
      kind: issue.kind,
      nextAction: nextActionForOptionalDependencyMaterialization(issue),
      specifier: issue.specifier
    }))
    .sort((left, right) => left.specifier.localeCompare(right.specifier));
  return {
    summary: createDependencyMaterializationSummary(missing, optional, satisfied),
    missing,
    optional,
    satisfied
  };
}

function inspectDependencyMaterializationPlan(
  options: ViteProductDependencyArtifactClosureOptions,
  dependencyArtifacts: readonly ViteProductDependencyArtifact[]
): ViteDependencyMaterializationPlan {
  const workflow = new ViteProductWorkflow({
    manager: options.manager,
    vitePackageArtifact: options.vitePackageArtifact,
    dependencyArtifacts: [...dependencyArtifacts],
    ...(options.wasmAdapterPolicy === undefined ? {} : { wasmAdapterPolicy: options.wasmAdapterPolicy }),
    ...(options.projectRoot === undefined ? {} : { projectRoot: options.projectRoot })
  });
  workflow.install();
  return workflow.inspectRealCliReadiness().dependencyMaterializationPlan;
}

function packageNameFromSpecifier(specifier: string): string | null {
  if (specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("#") || specifier.startsWith("node:")) return null;
  const parts = specifier.split("/");
  if (specifier.startsWith("@")) return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : null;
  return parts[0] || null;
}

function isPackageAliasName(aliasName: string, packageName: string | undefined): boolean {
  if (!packageName) return false;
  return aliasName.endsWith("-cjs") && aliasName.slice(0, -4) === packageName;
}

function classifyDependencyMaterialization(name: string, wasmAdapterPolicy: WasmAdapterPolicy | null): ViteDependencyMaterializationKind {
  const resolved = resolveWasmDependency(name, wasmAdapterPolicy);
  if (resolved?.action === "use-wasm") return "wasm-adapter-candidate";
  if (name === "esbuild" || name === "rolldown") return "wasm-adapter-candidate";
  if (name === "lightningcss") return "native-hold";
  return "package-artifact";
}

function nextActionForDependencyMaterialization(name: string, wasmAdapterPolicy: WasmAdapterPolicy | null): string {
  const kind = classifyDependencyMaterialization(name, wasmAdapterPolicy);
  if (kind === "wasm-adapter-candidate") {
    return "Materialize the JavaScript package surface and route native binding requests through an integrity-pinned WASM adapter.";
  }
  if (kind === "native-hold") {
    return "Keep this dependency optional or blocked until a supported browser/WASM replacement is proven.";
  }
  return "Extract this package from an installed node_modules tree and mount it as a dependency artifact.";
}

function wasmReplacementForDependency(
  name: string,
  wasmAdapterPolicy: WasmAdapterPolicy | null
): { wasm?: ViteDependencyMaterializationWasmReplacement } {
  const resolved = resolveWasmDependency(name, wasmAdapterPolicy);
  if (resolved?.action !== "use-wasm") return {};
  return {
    wasm: {
      ...(resolved.adapterName === undefined ? {} : { adapterName: resolved.adapterName }),
      fallbackPolicy: resolved.fallbackPolicy,
      ...(resolved.status === undefined ? {} : { status: resolved.status }),
      wasmPackage: resolved.wasmPackage
    }
  };
}

function artifactNamesForDependency(name: string, wasmAdapterPolicy: WasmAdapterPolicy | null): string[] {
  const resolved = resolveWasmDependency(name, wasmAdapterPolicy);
  if (resolved?.action !== "use-wasm") return [name];
  return uniquePackageNames([name, resolved.wasmPackage]);
}

function resolveWasmDependency(name: string, wasmAdapterPolicy: WasmAdapterPolicy | null): WasmAdapterPolicyAction | null {
  if (!wasmAdapterPolicy) return null;
  try {
    return wasmAdapterPolicy.resolvePackage(name);
  } catch {
    return null;
  }
}

function nextActionForOptionalDependencyMaterialization(issue: CliModuleGraphIssue): string {
  if (issue.kind === "optional-native-probe") {
    return "Leave this native probe optional unless the package path becomes required by the selected project.";
  }
  if (issue.kind === "optional-cache-probe") {
    return "Leave this cache optimization optional; runtime execution must continue without it.";
  }
  return "Leave this dependency optional unless a project feature explicitly imports it.";
}

function createDependencyMaterializationSummary(
  missing: readonly ViteDependencyMaterializationItem[],
  optional: readonly ViteDependencyMaterializationOptionalItem[],
  satisfied: readonly string[]
): ViteDependencyMaterializationSummary {
  const missingByKind: Record<ViteDependencyMaterializationKind, number> = {
    "package-artifact": 0,
    "wasm-adapter-candidate": 0,
    "native-hold": 0
  };
  for (const item of missing) {
    missingByKind[item.kind] += 1;
  }
  return {
    missingByKind,
    missingCount: missing.length,
    optionalCount: optional.length,
    satisfiedCount: satisfied.length
  };
}

function missingCapabilitiesForTemplate(template: ViteProductTemplate): ViteRuntimeCapability[] {
  const capabilities: ViteRuntimeCapability[] = [
    "actual-vite-cli-module-execution",
    "real-vite-http-module-transform",
    "real-vite-hmr-protocol"
  ];
  if (template !== "react" && template !== "vanilla") capabilities.push("framework-plugin-module-execution");
  return capabilities;
}

function createViteCapabilityStatus(options: {
  cliEntryReadiness: CliEntryReadiness;
  cliModuleGraph: CliModuleGraph;
  missingCapabilities: ViteRuntimeCapability[];
  vitePackageSource: ViteProductPackageSource;
}): ViteRuntimeCapabilityStatus[] {
  const statuses: ViteRuntimeCapabilityStatus[] = [
    createCapabilityStatus({
      capability: "esm-cli-entrypoint",
      evidence: "The Vite bin entrypoint is classified as ESM and accepted by the async CLI evaluator.",
      nextAction: "Expand CLI entrypoint classification before executing this package through the browser guest runtime.",
      status: options.cliEntryReadiness.status === "ready" ? "ready" : "blocked"
    }),
    createCapabilityStatus({
      capability: "minimal-vite-cli-module-graph",
      evidence: "The materialized Vite CLI module graph resolves bin/vite.js and dist node modules without missing-module issues.",
      nextAction: "Resolve the reported Vite CLI module graph issues before CLI-backed workflow execution.",
      status: options.cliModuleGraph.supported ? "ready" : "blocked"
    }),
    {
      capability: "cli-registration-hooks",
      evidence: "The materialized Vite CLI graph emits dev server, build, HMR, and transform registrations through runtime globals.",
      status: "ready"
    },
    {
      capability: "cli-backed-dev-build-workflow",
      evidence: "The product workflow can execute the Vite CLI entrypoint before starting dev/build lifecycle adapters.",
      status: "ready"
    }
  ];
  if (options.vitePackageSource === "mounted-artifact") {
    statuses.push({
      capability: "mounted-vite-artifact-input",
      evidence: "The workflow accepted an externally mounted Vite package artifact and analyzed that artifact's bin/module graph.",
      status: "ready"
    });
  }

  for (const capability of options.missingCapabilities) {
    statuses.push({
      capability,
      evidence: evidenceForMissingCapability(capability),
      nextAction: nextActionForMissingCapability(capability),
      status: "blocked"
    });
  }
  return statuses;
}

function createCapabilityStatus(options: ViteRuntimeCapabilityStatus & { nextAction: string }): ViteRuntimeCapabilityStatus {
  if (options.status === "ready") {
    return {
      capability: options.capability,
      evidence: options.evidence,
      status: "ready"
    };
  }
  return options;
}

function evidenceForMissingCapability(capability: ViteRuntimeCapability): string {
  switch (capability) {
    case "actual-vite-cli-module-execution":
      return "The current product workflow executes the materialized Vite CLI graph, not the vendored Vite package source.";
    case "real-vite-http-module-transform":
      return "HTTP module serving still uses the product adapter transform contract instead of Vite server transform middleware.";
    case "real-vite-hmr-protocol":
      return "HMR currently sends Vite wire-compatible payloads from the adapter instead of the real Vite server HMR implementation.";
    case "framework-plugin-module-execution":
      return "Vue and Svelte product workflows still model plugin readiness instead of executing framework plugins through Vite.";
  }
}

function nextActionForMissingCapability(capability: ViteRuntimeCapability): string {
  switch (capability) {
    case "actual-vite-cli-module-execution":
      return "Vendor or install the real Vite package artifact and run its CLI/module graph through the async browser guest evaluator.";
    case "real-vite-http-module-transform":
      return "Route preview module requests through real Vite transform middleware after the vendored server module boots.";
    case "real-vite-hmr-protocol":
      return "Connect the real Vite HMR channel to the preview socket lifecycle and preserve update diagnostics.";
    case "framework-plugin-module-execution":
      return "Execute the selected framework plugin module path under the same Vite server runtime.";
  }
}

function dependenciesForTemplate(template: ViteProductTemplate): Record<string, string> {
  if (template === "vanilla") return {};
  if (template === "react") {
    return {
      "@vitejs/plugin-react": "latest",
      react: "18.3.1",
      "react-dom": "18.3.1"
    };
  }
  if (template === "vue-runtime") return { vue: "3.5.25" };
  return {
    "@sveltejs/vite-plugin-svelte": "7.3.0",
    svelte: "5.57.0"
  };
}

function sourceMountsForTemplate(
  projectRoot: string,
  template: ViteProductTemplate
): PackageManagerWorkspaceMount[] {
  if (template === "vanilla") {
    return [{
      path: join(projectRoot, "src/main.js"),
      data: "import { label } from \"./message.js\";\nimport \"./style.css\";\nconst app = document.querySelector(\"#app\");\nif (app) app.textContent = `${label}:1`;\n"
    }];
  }
  if (template === "react") {
    return [{
      path: join(projectRoot, "src/main.jsx"),
      data: "import React from \"react\";\nimport { createRoot } from \"react-dom/client\";\nimport { label } from \"./message.js\";\ncreateRoot(document.getElementById(\"app\")).render(`${label}:1`);\n"
    }];
  }
  if (template === "vue-runtime") {
    return [{
      path: join(projectRoot, "src/main.js"),
      data: "import { createApp, h } from \"vue\";\nimport { label } from \"./message.js\";\nglobalThis.__fixtureState ||= { count: 1 };\ncreateApp({ render: () => h(\"div\", { id: \"app\" }, `${label}:${globalThis.__fixtureState.count}`) }).mount(\"#app\");\n"
    }];
  }
  return [
    {
      path: join(projectRoot, "vite.config.js"),
      data: "import { svelte } from \"@sveltejs/vite-plugin-svelte\";\nexport default { plugins: [svelte()] };\n"
    },
    {
      path: join(projectRoot, "src/main.js"),
      data: "import App from \"./App.svelte\";\nexport default new App({ target: document.getElementById(\"app\") });\n"
    },
    {
      path: join(projectRoot, "src/App.svelte"),
      data: "<script>import { label } from \"./message.js\"; globalThis.__fixtureState ||= { count: 1 };</script>\n<div id=\"app\">{label}:{globalThis.__fixtureState.count}</div>\n"
    }
  ];
}

function renderHtml(label: string, count: number): string {
  // Fallback used by build() smoke output when a full preview document is not needed.
  return `<!doctype html><div id="app">${label}:${count}</div>`;
}

function toRuntimeHttpResponse(preview: ViteProductPreviewResult): RuntimeHttpResponse {
  return {
    statusCode: preview.statusCode,
    headers: preview.headers || { "content-type": "text/html; charset=utf-8" },
    body: preview.body
  };
}

function previewBodyText(body: ViteProductPreviewResult["body"]): string {
  if (typeof body !== "string") throw new Error("Expected a text Preview response");
  return body;
}

function decodePreviewText(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function toResponseBody(body: RuntimeHttpResponse["body"]): BodyInit {
  if (!(body instanceof Uint8Array)) return body || "";
  const copy = new Uint8Array(body.byteLength);
  copy.set(body);
  return copy.buffer;
}

function contentTypeForPath(path: string): string {
  if (path.endsWith(".css")) return "text/css; charset=utf-8";
  if (path.endsWith(".html")) return "text/html; charset=utf-8";
  if (path.endsWith(".svelte")) return "text/javascript; charset=utf-8";
  if (path.endsWith(".js") || path.endsWith(".jsx") || path.endsWith(".ts") || path.endsWith(".tsx")) {
    return "text/javascript; charset=utf-8";
  }
  return "application/octet-stream";
}

function transformViteModuleSource(
  path: string,
  source: string,
  moduleTransformSource: "adapter" | "vite-cli" | string = "adapter"
): string {
  if (!/\.(?:[cm]?jsx?|tsx?)$/.test(path)) return source;
  if (moduleTransformSource === "vite-cli") {
    return `// transformed by vite-cli\n${source}`;
  }
  // Adapter preview path: emit browser-runnable ESM for TS/JSX so React/Vite edits show up.
  if (/\.(?:[cm]?tsx?|jsx)$/.test(path)) {
    try {
      const result = transpileTypeScript(source, {
        fileName: path,
        jsx: /\.(?:jsx|tsx)$/.test(path) ? "react-jsx" : "react"
      });
      return rewriteBrowserModuleImports(result.code);
    } catch {
      return rewriteBrowserModuleImports(source);
    }
  }
  return rewriteBrowserModuleImports(source);
}

function rewriteBrowserModuleImports(source: string): string {
  let next = source.replace(
    /import\s+["'](\.[^"']+\.(?:css|scss|sass|less))["'];?/g,
    (_full, specifier: string) => (
      `(() => { const href = new URL(${JSON.stringify(specifier)}, import.meta.url).href; if (![...document.querySelectorAll('link[rel="stylesheet"]')].some((node) => node.href === href)) { const link = document.createElement("link"); link.rel = "stylesheet"; link.href = href; document.head.appendChild(link); } })();`
    )
  );
  next = next.replace(
    /from\s+["'](\.[^"']+)["']/g,
    (full, specifier: string) => {
      if (/\.[a-z0-9]+$/i.test(specifier)) return full;
      return full.replace(specifier, `${specifier}.js`);
    }
  );
  return next;
}

function normalizeServedPath(path: string): string {
  const normalized = path.replaceAll("\\", "/").replace(/\/+/g, "/");
  return normalized.startsWith("/") ? normalized : `/${normalized}`;
}

function hmrLabelForSource(path: string, source: string): string {
  const label = source.match(/label\s*=\s*"([^"]+)"/)?.[1];
  if (label) return label;
  const segments = path.split("/").filter(Boolean);
  return segments.at(-1) || path;
}

function assertViteDevCommand(command: string): void {
  if (!/^vite(\s|$)/.test(command) || command.includes(" build") || command.includes(" preview")) {
    throw new Error(`unsupported Vite dev command: ${command}`);
  }
}

function assertViteBuildCommand(command: string): void {
  if (command !== "vite build") throw new Error(`unsupported Vite build command: ${command}`);
}

function commandArgs(command: string): string[] {
  return command.split(/\s+/).slice(1).filter(Boolean);
}

function parseViteReadyPort(stdout: string): number | null {
  const match = stdout.match(/http:\/\/(?:127\.0\.0\.1|localhost):(\d+)\//);
  return match?.[1] ? Number(match[1]) : null;
}

function latestHmrSendUpdate(registrations: ViteProductCliHmrRegistration[]): ViteProductCliHmrSendUpdate | null {
  for (let index = registrations.length - 1; index >= 0; index -= 1) {
    const registration = registrations[index];
    if (registration?.sendUpdate) return registration.sendUpdate;
  }
  return null;
}

function latestTransformRequest(registrations: ViteProductCliTransformRegistration[]): ViteProductCliTransformRequest | null {
  for (let index = registrations.length - 1; index >= 0; index -= 1) {
    const registration = registrations[index];
    if (registration?.transformRequest) return registration.transformRequest;
  }
  return null;
}
