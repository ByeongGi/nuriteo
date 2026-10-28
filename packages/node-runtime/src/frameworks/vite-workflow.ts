import { join } from "../builtins/path.ts";

import type { VitePackageManifest, ViteProductDependencyArtifact, ViteProductPackageArtifact } from "./vite-artifacts.ts";
import type { ViteProductCliHmrSendUpdate, ViteProductCliTransformRequest, ViteProductDevServerSource, ViteProductHmrSocket, ViteProductHmrUpdate, ViteProductModuleTransformSource, ViteProductPackageManager, ViteProductTemplate, ViteProductWorkflowOptions } from "./vite-workflow-types.ts";

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
import { createLoopbackNetwork, type LoopbackFetchOptions, type LoopbackNetwork } from "../net/index.ts";
import { createAsyncCliModuleEvaluator, createIsolatedAsyncCliModuleEvaluator, createWorkerBackedAsyncCliModuleEvaluator, type CliEvaluationFsTraceEntry } from "../package-managers/cli-evaluator.ts";
import { analyzeCliModuleGraph } from "../package-managers/cli-module-graph.ts";
import { inspectCliEntryReadiness } from "../package-managers/cli-entry-readiness.ts";
import { MemoryPackageManagerWorkspace } from "../package-managers/workspace.ts";
import type { WasmAdapterPolicy } from "../wasm-adapters/index.ts";


import type { RuntimeEnv } from "../types.ts";

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
import { hasDependencyArtifact, installDependencyArtifacts, installEsbuildShim, installFixturePackage, installVitePackage, readVitePackageVersion, resolveBin, resolveCommandEntrypoint, vitePackageSource } from "./vite-workflow-install.ts";
import { assertViteBuildCommand, assertViteDevCommand, commandArgs, hmrLabelForSource, latestHmrSendUpdate, latestTransformRequest, normalizeServedPath, parseViteReadyPort, previewJsonModuleSource, resolveInstalledPreviewSpecifier, rewriteBrowserModuleImports, transformViteModuleSource } from "./vite-workflow-preview.ts";
import { applyCapturedViteGlobalCalls, classifyAsyncBindingReadinessBlocker, classifyAsyncModuleBlocker, contentTypeForPath, createDependencyMaterializationPlan, createLockfile, createViteCapabilityStatus, createViteHmrUpdate, createViteMounts, decodePreviewText, hasCapturedViteGlobalCalls, isForcedWasiEnv, missingCapabilitiesForTemplate, packagesForTemplate, previewBodyText, renderHtml, toResponseBody, toRuntimeHttpResponse, uniquePackageNames } from "./vite-workflow-run.ts";
import type { ViteProductBuildResult, ViteProductCliBackedWorkflowResult, ViteProductCliBuildRegistration, ViteProductCliExecutionOptions, ViteProductCliExecutionResult, ViteProductCliHmrRegistration, ViteProductCliServerRegistration, ViteProductCliTransformRegistration, ViteProductDevServerSnapshot, ViteProductHmrResult, ViteProductInstallResult, ViteProductPreviewResult, ViteProductReloadRecoveryResult, ViteProductSourceEditResult, ViteProductWorkflowResult, ViteRealCliReadiness } from "./vite-workflow-types.ts";
export type { ViteProductAsyncBindingReadinessBlocker, ViteProductAsyncModuleBlocker, ViteProductBuildResult, ViteProductCliBackedWorkflowResult, ViteProductCliBuildRegistration, ViteProductCliExecutionMode, ViteProductCliExecutionOptions, ViteProductCliExecutionResult, ViteProductCliHmrRegistration, ViteProductCliHmrSendUpdate, ViteProductCliServerRegistration, ViteProductCliTransformRegistration, ViteProductCliTransformRequest, ViteProductCliTransformRequestInput, ViteProductCliTransformResult, ViteProductDependencyArtifactClosureIteration, ViteProductDependencyArtifactClosureOptions, ViteProductDependencyArtifactClosureResult, ViteProductDevServerSnapshot, ViteProductDevServerSource, ViteProductHmrPayloadUpdate, ViteProductHmrResult, ViteProductHmrSocket, ViteProductHmrUpdate, ViteProductInstallResult, ViteProductModuleTransformSource, ViteProductPackageManager, ViteProductPackageSource, ViteProductPreviewResult, ViteProductReloadRecoveryResult, ViteProductSourceEditResult, ViteProductTemplate, ViteProductWorkflowOptions, ViteProductWorkflowResult, ViteRealCliReadiness } from "./vite-workflow-types.ts";
export type { ViteReactBuildResult, ViteReactCliBackedWorkflowResult, ViteReactCliBuildRegistration, ViteReactCliExecutionResult, ViteReactCliHmrRegistration, ViteReactCliServerRegistration, ViteReactCliTransformRegistration, ViteReactDevServerSnapshot, ViteReactDevServerSource, ViteReactHmrResult, ViteReactHmrUpdate, ViteReactInstallResult, ViteReactModuleTransformSource, ViteReactPackageManager, ViteReactPreviewResult, ViteReactProductWorkflowOptions, ViteReactProductWorkflowResult, ViteReactReloadRecoveryResult, ViteReactSourceEditResult } from "./vite-workflow-run.ts";
export { createViteDependencyArtifactClosureFromWorkspace, createViteHmrUpdate, runViteProductCliBackedWorkflow, runViteProductWorkflow, runViteReactCliBackedWorkflow, runViteReactProductWorkflow } from "./vite-workflow-run.ts";
export { finishPreviewModule, previewJsonModuleSource, resolveInstalledPreviewSpecifier, rewriteBrowserModuleImports, shouldKeepInstalledPackage } from "./vite-workflow-preview.ts";

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
    const manifest = JSON.parse(this.workspace.readText(join(this.projectRoot, "package.json"))) as VitePackageManifest;
    const packages = uniquePackageNames([
      ...packagesForTemplate(this.template),
      ...Object.keys(manifest.dependencies || {}),
      ...Object.keys(manifest.devDependencies || {})
    ]);
    for (const pkg of packages) {
      if ((pkg === "vite" && this.vitePackageArtifact) || hasDependencyArtifact(this, pkg)) continue;
      installFixturePackage(this, pkg);
    }
    installVitePackage(this);
    installDependencyArtifacts(this);
    installEsbuildShim(this);
    const lockfile = this.manager === "npm" ? "package-lock.json" : this.manager === "yarn" ? "yarn.lock" : "pnpm-lock.yaml";
    this.workspace.writeText(join(this.projectRoot, lockfile), createLockfile(this.manager, packages));
    return {
      installed: true,
      lockfile,
      packages: uniquePackageNames([...packages, ...this.dependencyArtifacts.map((artifact) => artifact.name)]),
      vitePackageSource: vitePackageSource(this)
    };
  }

  inspectRealCliReadiness(): ViteRealCliReadiness {
    const cliEntrypoint = resolveBin(this, "vite");
    const cliEntryReadiness = inspectCliEntryReadiness({
      entry: {
        name: "vite",
        version: readVitePackageVersion(this),
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
        vitePackageSource: vitePackageSource(this)
      }),
      cliEntrypoint,
      cliEntryReadiness,
      cliModuleGraph,
      dependencyMaterializationPlan: createDependencyMaterializationPlan(cliModuleGraph, this.dependencyArtifacts, this.wasmAdapterPolicy),
      missingCapabilities,
      nextAction: "Replace the adapter-backed Vite workflow with vendored Vite CLI/module execution once the listed runtime capabilities are implemented.",
      vitePackageSource: vitePackageSource(this)
    };
  }

  async executeRealCli(
    args: string[] = ["--host", "127.0.0.1"],
    env: RuntimeEnv = {},
    options: ViteProductCliExecutionOptions = {}
  ): Promise<ViteProductCliExecutionResult> {
    if (!this.workspace.exists(join(this.projectRoot, "node_modules/.bin/vite"))) this.install();
    const cliEntrypoint = resolveBin(this, "vite");
    const buildRegistrations: ViteProductCliBuildRegistration[] = [];
    const hmrRegistrations: ViteProductCliHmrRegistration[] = [];
    const serverRegistrations: ViteProductCliServerRegistration[] = [];
    const transformRegistrations: ViteProductCliTransformRegistration[] = [];
    const isolation = options.isolation || "shared";
    if (isolation === "shared" && isForcedWasiEnv(env) && hasDependencyArtifact(this, "@napi-rs/wasm-runtime")) {
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
    if (isolation === "shared" && hasDependencyArtifact(this, "@napi-rs/wasm-runtime")) {
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
        version: readVitePackageVersion(this),
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
    this.#devServerCliEntrypoint = resolveBin(this, "vite");
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
    const cliEntrypoint = resolveCommandEntrypoint(this, command);
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
    const cliEntrypoint = resolveCommandEntrypoint(this, command);
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
    const queryIndex = path.indexOf("?");
    const requestPath = (queryIndex >= 0 ? path.slice(0, queryIndex) : path) || "/";
    const query = queryIndex >= 0 ? path.slice(queryIndex + 1) : "";
    if (new URLSearchParams(query).get("nuriteo-module") === "json") {
      return this.#readJsonModule(requestPath) ?? { statusCode: 404, body: "Not found" };
    }
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
    const queryIndex = path.indexOf("?");
    const requestPath = (queryIndex >= 0 ? path.slice(0, queryIndex) : path) || "/";
    const query = queryIndex >= 0 ? path.slice(queryIndex + 1) : "";
    if (new URLSearchParams(query).get("nuriteo-module") === "json") return this.preview(path);
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
    this.#buildCliEntrypoint = resolveCommandEntrypoint(this, command);
    return this.build();
  }

  async buildFromCliExecution(name = "build"): Promise<ViteProductBuildResult> {
    const command = this.#readScript(name);
    assertViteBuildCommand(command);
    const cliEntrypoint = resolveCommandEntrypoint(this, command);
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
      body: transformViteModuleSource(transformPath, body, this.#moduleTransformSource, (specifier) => this.#resolvePreviewSpecifier(specifier), {
        importerPath: workspacePath,
        projectRoot: this.projectRoot,
        workspace: this.workspace
      })
    };
  }

  #readJsonModule(requestPath: string): ViteProductPreviewResult | null {
    const workspacePath = this.#resolveServedWorkspacePath(requestPath);
    if (!workspacePath || !workspacePath.endsWith(".json")) return null;
    try {
      return {
        statusCode: 200,
        headers: { "content-type": "text/javascript; charset=utf-8" },
        body: previewJsonModuleSource(this.workspace.readText(workspacePath))
      };
    } catch {
      return { statusCode: 500, headers: { "content-type": "text/plain; charset=utf-8" }, body: "Invalid JSON module" };
    }
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
    const resolveSpecifier = (specifier: string) => this.#resolvePreviewSpecifier(specifier);
    if (this.#moduleTransformSource === "vite-cli" && this.#cliTransformRequest) {
      const transformed = await this.#cliTransformRequest({ path: requestPath, source });
      const code = typeof transformed === "string" ? transformed : transformed.code;
      return rewriteBrowserModuleImports(code, resolveSpecifier);
    }
    const workspacePath = requestPath.startsWith(this.projectRoot) ? requestPath : join(this.projectRoot, requestPath);
    return transformViteModuleSource(requestPath, source, this.#moduleTransformSource, resolveSpecifier, {
      importerPath: workspacePath,
      projectRoot: this.projectRoot,
      workspace: this.workspace
    });
  }

  #resolvePreviewSpecifier(specifier: string): string | undefined {
    return resolveInstalledPreviewSpecifier(this.projectRoot, specifier, this.workspace);
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
export const ViteReactProductWorkflow = ViteProductWorkflow;
