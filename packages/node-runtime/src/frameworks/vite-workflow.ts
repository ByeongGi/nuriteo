import { join } from "../builtins/path.ts";
import { spawnRuntimeChild, type RuntimeChildProcess } from "../child-process.ts";
import { createLoopbackNetwork, type LoopbackNetwork, type RuntimeHttpResponse } from "../net/index.ts";
import { createAsyncCliModuleEvaluator } from "../package-managers/cli-evaluator.ts";
import { analyzeCliModuleGraph, type CliModuleGraph } from "../package-managers/cli-module-graph.ts";
import { inspectCliEntryReadiness, type CliEntryReadiness } from "../package-managers/cli-entry-readiness.ts";
import { MemoryPackageManagerWorkspace, type PackageManagerWorkspaceMount } from "../package-managers/workspace.ts";
import type { CliRunResult, RuntimeEnv } from "../types.ts";

export type ViteProductPackageManager = "npm" | "pnpm";
export type ViteProductTemplate = "react" | "vue-runtime" | "svelte";

export interface ViteProductWorkflowOptions {
  manager: ViteProductPackageManager;
  template?: ViteProductTemplate;
  vitePackageArtifact?: ViteProductPackageArtifact;
  projectId?: string;
  projectRoot?: string;
  initialLabel?: string;
  network?: LoopbackNetwork;
  port?: number;
}

export interface ViteProductPackageArtifact {
  mounts: PackageManagerWorkspaceMount[];
  version: string;
}

export type ViteProductPackageArtifactErrorCode = "EVITEARTIFACTMANIFEST" | "EVITEARTIFACTNAME" | "EVITEARTIFACTBIN";

export class ViteProductPackageArtifactError extends Error {
  code: ViteProductPackageArtifactErrorCode;
  path: string;

  constructor(code: ViteProductPackageArtifactErrorCode, message: string, path: string) {
    super(message);
    this.name = "ViteProductPackageArtifactError";
    this.code = code;
    this.path = path;
  }
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
  buildRegistrations: ViteProductCliBuildRegistration[];
  cwd: string;
  hmrRegistrations: ViteProductCliHmrRegistration[];
  mode: "async-cli-module-evaluation";
  serverRegistrations: ViteProductCliServerRegistration[];
  transformRegistrations: ViteProductCliTransformRegistration[];
}

export interface ViteProductCliBuildRegistration {
  command: "build";
  outDir: string;
  source: "vite-cli";
}

export interface ViteProductCliHmrRegistration {
  channel: "hmr";
  source: "vite-cli";
  transport: "loopback";
}

export interface ViteProductCliServerRegistration {
  command: "dev";
  host: string;
  port: number;
  source: "vite-cli";
}

export interface ViteProductCliTransformRegistration {
  mode: "browser-esm";
  source: "vite-cli";
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
  body: string;
}

export interface ViteProductHmrResult {
  before: string;
  after: string;
  statePreserved: boolean;
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
  missingCapabilities: ViteRuntimeCapability[];
  nextAction: string;
  vitePackageSource: ViteProductPackageSource;
}

export interface ViteRuntimeCapabilityStatus {
  capability: ViteRuntimeReadinessCapability;
  evidence: string;
  nextAction?: string;
  status: "ready" | "blocked";
}

export type ViteRuntimeReadinessCapability =
  | ViteRuntimeCapability
  | "esm-cli-entrypoint"
  | "minimal-vite-cli-module-graph"
  | "cli-registration-hooks"
  | "cli-backed-dev-build-workflow";

export type ViteRuntimeCapability =
  | "actual-vite-cli-module-execution"
  | "real-vite-http-module-transform"
  | "real-vite-hmr-protocol"
  | "framework-plugin-module-execution";

interface VitePackageManifest {
  bin?: string | Record<string, string>;
  name?: string;
  version?: string;
}

export class ViteProductWorkflow {
  readonly manager: ViteProductPackageManager;
  readonly template: ViteProductTemplate;
  readonly projectId: string;
  readonly projectRoot: string;
  readonly vitePackageArtifact: ViteProductPackageArtifact | null;
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
    this.vitePackageArtifact = options.vitePackageArtifact || null;
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
      if (pkg === "vite" && this.vitePackageArtifact) continue;
      this.workspace.writeText(join(this.projectRoot, "node_modules", pkg, "package.json"), JSON.stringify({ name: pkg }));
    }
    this.#installVitePackage();
    const lockfile = this.manager === "npm" ? "package-lock.json" : "pnpm-lock.yaml";
    this.workspace.writeText(join(this.projectRoot, lockfile), createLockfile(this.manager, packages));
    return { installed: true, lockfile, packages, vitePackageSource: this.#vitePackageSource() };
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
        missingCapabilities
      }),
      cliEntrypoint,
      cliEntryReadiness,
      cliModuleGraph,
      missingCapabilities,
      nextAction: "Replace the adapter-backed Vite workflow with vendored Vite CLI/module execution once the listed runtime capabilities are implemented.",
      vitePackageSource: this.#vitePackageSource()
    };
  }

  async executeRealCli(args: string[] = ["--host", "127.0.0.1"], env: RuntimeEnv = {}): Promise<ViteProductCliExecutionResult> {
    if (!this.workspace.exists(join(this.projectRoot, "node_modules/.bin/vite"))) this.install();
    const cliEntrypoint = this.#resolveBin("vite");
    const buildRegistrations: ViteProductCliBuildRegistration[] = [];
    const hmrRegistrations: ViteProductCliHmrRegistration[] = [];
    const serverRegistrations: ViteProductCliServerRegistration[] = [];
    const transformRegistrations: ViteProductCliTransformRegistration[] = [];
    const result = await createAsyncCliModuleEvaluator({
      root: this.projectRoot,
      reader: this.workspace,
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
        }
      }
    })({
      entry: {
        name: "vite",
        version: this.#readVitePackageVersion(),
        entry: cliEntrypoint,
        mode: "esm"
      },
      args,
      cwd: this.projectRoot,
      env
    });
    return {
      ...result,
      args,
      buildRegistrations,
      cwd: this.projectRoot,
      hmrRegistrations,
      mode: "async-cli-module-evaluation",
      serverRegistrations,
      transformRegistrations
    };
  }

  startDevServer(): ViteProductDevServerSnapshot {
    if (this.#listener) return this.#snapshot();
    this.#devServerSource = "adapter";
    this.#devServerCommand = "vite --host 127.0.0.1";
    this.#devServerCliEntrypoint = this.#resolveBin("vite");
    this.#listener = this.network.listen(this.#port, (request) => {
      this.#requests.push(request.path);
      const preview = this.preview(request.path);
      return toRuntimeHttpResponse(preview);
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
    return this.#snapshot();
  }

  async startDevServerFromCliExecution(name = "dev"): Promise<ViteProductDevServerSnapshot> {
    const command = this.#readScript(name);
    assertViteDevCommand(command);
    const cliEntrypoint = this.#resolveCommandEntrypoint(command);
    const args = commandArgs(command);
    const cliExecution = await this.executeRealCli(args, { PORT: String(this.#port) });
    const registration = cliExecution.serverRegistrations.at(-1);
    if (!registration) throw new Error("ERR_VITE_CLI_SERVER_REGISTRATION_MISSING");
    if (!cliExecution.transformRegistrations.some((item) => item.source === "vite-cli")) {
      throw new Error("ERR_VITE_CLI_TRANSFORM_REGISTRATION_MISSING");
    }
    this.#port = registration.port;
    this.startDevServer();
    this.#devServerSource = "cli-execution";
    this.#devServerCommand = command;
    this.#devServerCliEntrypoint = cliEntrypoint;
    this.#moduleTransformSource = "vite-cli";
    return this.#snapshot();
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
        body: "export const createHotContext = () => ({ accept() {} });\n"
      };
    }
    if (requestPath !== "/" && requestPath !== "/index.html") {
      const source = this.#readServedSource(requestPath);
      if (source) return source;
      return { statusCode: 404, body: "Not found" };
    }
    return {
      statusCode: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
      body: renderHtml(this.#readLabel(), this.#state.count)
    };
  }

  async fetch(input: string | URL): Promise<Response> {
    const response = await this.network.fetch(input);
    const init: ResponseInit = { status: response.statusCode };
    if (response.statusText) init.statusText = response.statusText;
    if (response.headers) init.headers = response.headers;
    return new Response(response.body || "", init);
  }

  editMessage(label: string): ViteProductHmrResult {
    const before = this.preview("/").body;
    this.workspace.writeText(join(this.projectRoot, "src/message.js"), `export const label = "${label}";\n`);
    const after = this.preview("/").body;
    const update = createViteHmrUpdate("/src/message.js", label);
    this.#hmrUpdates.push(update);
    this.#broadcastHmr(update);
    return {
      before,
      after,
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
    this.#hmrSockets.add(socket);
    queueMicrotask(() => {
      if (this.#hmrSockets.has(socket)) socket.onmessage?.({ data: JSON.stringify({ type: "connected" }) });
    });
    return socket;
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
      previewAfterRestart: this.preview("/").body
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
    const source = this.workspace.readText(join(this.projectRoot, "src/message.js"));
    return source.match(/label\s*=\s*"([^"]+)"/)?.[1] || "unknown";
  }

  #readScript(name: string): string {
    const manifest = JSON.parse(this.workspace.readText(join(this.projectRoot, "package.json"))) as { scripts?: Record<string, string> };
    const command = manifest.scripts?.[name];
    if (!command) throw new Error(`missing package script: ${name}`);
    return command;
  }

  #readServedSource(requestPath: string): ViteProductPreviewResult | null {
    const workspacePath = join(this.projectRoot, requestPath);
    if (!this.workspace.exists(workspacePath)) return null;
    const body = this.workspace.readText(workspacePath);
    return {
      statusCode: 200,
      headers: { "content-type": contentTypeForPath(requestPath) },
      body: this.#moduleTransformSource === "vite-cli" ? transformViteModuleSource(requestPath, body) : body
    };
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
      this.workspace.writeText(join(packageRoot, normalizePackageArtifactPath(mount.path)), mount.data);
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
      "export function createHotChannel(server) {\n  server.emit('vite:hmr-ready');\n  global.__viteRegisterHmrChannel?.({ channel: 'hmr', source: 'vite-cli', transport: 'loopback' });\n  return { send() {} };\n}\n"
    );
    this.workspace.writeText(
      join(this.projectRoot, "node_modules/vite/dist/node/transform.js"),
      "export function registerTransform() {\n  global.__viteRegisterTransform?.({ mode: 'browser-esm', source: 'vite-cli' });\n}\n"
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
}

export function runViteProductWorkflow(options: ViteProductWorkflowOptions): ViteProductWorkflowResult {
  return new ViteProductWorkflow(options).run();
}

export function runViteProductCliBackedWorkflow(options: ViteProductWorkflowOptions): Promise<ViteProductCliBackedWorkflowResult> {
  return new ViteProductWorkflow(options).runCliBacked();
}

export const ViteReactProductWorkflow = ViteProductWorkflow;

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
export type ViteReactBuildResult = ViteProductBuildResult;
export type ViteReactReloadRecoveryResult = ViteProductReloadRecoveryResult;

function createViteMounts(projectRoot: string, template: ViteProductTemplate, label: string): PackageManagerWorkspaceMount[] {
  const entry = template === "react" ? "/src/main.jsx" : "/src/main.js";
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
          typescript: "6.0.3",
          ...dependenciesForTemplate(template)
        }
      })
    },
    {
      path: join(projectRoot, "index.html"),
      data: `<div id="root"></div><script type="module" src="${entry}"></script>\n`
    },
    ...sourceMountsForTemplate(projectRoot, template),
    {
      path: join(projectRoot, "src/message.js"),
      data: `export const label = "${label}";\n`
    },
    {
      path: join(projectRoot, "src/style.css"),
      data: "#app { font-family: system-ui, sans-serif; }\n"
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
  return [
    "lockfileVersion: '9.0'",
    "importers:",
    "  .:",
    "    dependencies:",
    ...packages.map((pkg) => `      ${pkg}: product-fixture`)
  ].join("\n") + "\n";
}

function packagesForTemplate(template: ViteProductTemplate): string[] {
  return ["vite", "typescript", ...Object.keys(dependenciesForTemplate(template))];
}

function normalizePackageArtifactPath(path: string): string {
  return path.replace(/^\/+/, "");
}

function readVitePackageBinPath(manifest: VitePackageManifest): string {
  if (typeof manifest.bin === "string") return manifest.bin;
  return manifest.bin?.vite || "bin/vite.js";
}

function missingCapabilitiesForTemplate(template: ViteProductTemplate): ViteRuntimeCapability[] {
  const capabilities: ViteRuntimeCapability[] = [
    "actual-vite-cli-module-execution",
    "real-vite-http-module-transform",
    "real-vite-hmr-protocol"
  ];
  if (template !== "react") capabilities.push("framework-plugin-module-execution");
  return capabilities;
}

function createViteCapabilityStatus(options: {
  cliEntryReadiness: CliEntryReadiness;
  cliModuleGraph: CliModuleGraph;
  missingCapabilities: ViteRuntimeCapability[];
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

function sourceMountsForTemplate(projectRoot: string, template: ViteProductTemplate): PackageManagerWorkspaceMount[] {
  if (template === "react") {
    return [{
      path: join(projectRoot, "src/main.jsx"),
      data: "import React from \"react\";\nimport { createRoot } from \"react-dom/client\";\nimport { label } from \"./message.js\";\ncreateRoot(document.getElementById(\"root\")).render(`${label}:1`);\n"
    }];
  }
  if (template === "vue-runtime") {
    return [{
      path: join(projectRoot, "src/main.js"),
      data: "import { createApp, h } from \"vue\";\nimport { label } from \"./message.js\";\nglobalThis.__fixtureState ||= { count: 1 };\ncreateApp({ render: () => h(\"div\", { id: \"app\" }, `${label}:${globalThis.__fixtureState.count}`) }).mount(\"#root\");\n"
    }];
  }
  return [
    {
      path: join(projectRoot, "vite.config.js"),
      data: "import { svelte } from \"@sveltejs/vite-plugin-svelte\";\nexport default { plugins: [svelte()] };\n"
    },
    {
      path: join(projectRoot, "src/main.js"),
      data: "import App from \"./App.svelte\";\nexport default new App({ target: document.getElementById(\"root\") });\n"
    },
    {
      path: join(projectRoot, "src/App.svelte"),
      data: "<script>import { label } from \"./message.js\"; globalThis.__fixtureState ||= { count: 1 };</script>\n<div id=\"app\">{label}:{globalThis.__fixtureState.count}</div>\n"
    }
  ];
}

function renderHtml(label: string, count: number): string {
  return `<!doctype html><div id="app">${label}:${count}</div>`;
}

function toRuntimeHttpResponse(preview: ViteProductPreviewResult): RuntimeHttpResponse {
  return {
    statusCode: preview.statusCode,
    headers: preview.headers || { "content-type": "text/html; charset=utf-8" },
    body: preview.body
  };
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

function transformViteModuleSource(path: string, source: string): string {
  if (!/\.(?:[cm]?jsx?|tsx?)$/.test(path)) return source;
  return `// transformed by vite-cli\n${source}`;
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
