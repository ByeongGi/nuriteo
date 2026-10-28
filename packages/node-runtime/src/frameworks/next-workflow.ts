import { join } from "../builtins/path.ts";
import { spawnRuntimeChild, type RuntimeChildProcess } from "../child-process.ts";
import { createLoopbackNetwork, type LoopbackFetchOptions, type LoopbackNetwork } from "../net/index.ts";
import { createAsyncCliModuleEvaluator } from "../package-managers/cli-evaluator.ts";
import { analyzeCliModuleGraph, type CliModuleGraph } from "../package-managers/cli-module-graph.ts";
import { inspectCliEntryReadiness, type CliEntryReadiness } from "../package-managers/cli-entry-readiness.ts";
import { MemoryPackageManagerWorkspace, type PackageManagerWorkspaceMount } from "../package-managers/workspace.ts";

import type { CliRunResult, RuntimeEnv } from "../types.ts";
import type { WorkspaceModuleReader } from "../modules/index.ts";
import { createViteHmrUpdate, previewJsonModuleSource, resolveInstalledPreviewSpecifier, shouldKeepInstalledPackage, type ViteProductHmrSocket, type ViteProductHmrUpdate } from "./vite-workflow.ts";
import { JSX_RUNTIME_SHIM, REACT_DOM_SHIM, REACT_SHIM, assertNextDevCommand, assertNextStartCommand, commandArgs, createNextMounts, escapeHtml, toRuntimeHttpResponse } from "./next-workflow-files.ts";
import { assertNextBuildCommand, buildAppRouterBootstrap, contentTypeForPath, decodeBase64, hmrLabelForSource, normalizePackageArtifactPath, normalizeRoutePath, normalizeServedPath, readNextPackageBinPath, toResponseBody, transformModule, transformServedModule } from "./next-workflow-files.ts";

export { createNextPackageArtifactFromWorkspace, createNextDependencyArtifactFromWorkspace, createNextMounts, buildAppRouterBootstrap, transformModule, transformServedModule, assertNextDevCommand, assertNextBuildCommand, assertNextStartCommand, commandArgs, readNextPackageBinPath, normalizePackageArtifactPath, collectPackageMounts, workspaceReaderExists, isBinaryPackageMount, readWorkspaceBytes, encodeBase64, decodeBase64, normalizeServedPath, normalizeRoutePath, contentTypeForPath, hmrLabelForSource, escapeHtml, toRuntimeHttpResponse, toResponseBody, REACT_SHIM, JSX_RUNTIME_SHIM, REACT_DOM_SHIM } from "./next-workflow-files.ts";

export type NextProductPackageManager = "npm" | "pnpm" | "yarn";

export interface NextProductWorkflowOptions {
  dependencyArtifacts?: NextProductDependencyArtifact[];
  manager: NextProductPackageManager;
  nextPackageArtifact?: NextProductPackageArtifact;
  projectId?: string;
  projectRoot?: string;
  initialTitle?: string;
  network?: LoopbackNetwork;
  port?: number;
}

export interface NextProductPackageArtifact {
  mounts: PackageManagerWorkspaceMount[];
  version: string;
}

export interface NextProductPackageArtifactFromWorkspaceOptions {
  packageRoot: string;
  reader: WorkspaceModuleReader;
  version?: string;
}

export interface NextProductDependencyArtifact {
  mounts: PackageManagerWorkspaceMount[];
  name: string;
  version?: string;
}

export interface NextProductDependencyArtifactFromWorkspaceOptions {
  name?: string;
  packageRoot: string;
  reader: WorkspaceModuleReader;
  version?: string;
}

export type NextProductPackageSource = "stub" | "mounted-artifact";

export interface NextProductInstallResult {
  packages: string[];
  manager: NextProductPackageManager;
  nextPackageSource: NextProductPackageSource;
}

export interface NextProductCliServerRegistration {
  command: "dev" | "start";
  host: string;
  port: number;
  source: "next-cli";
}

export interface NextProductCliBuildRegistration {
  command: "build";
  outputDirectory: string;
  source: "next-cli";
}

export interface NextProductCliExecutionResult extends CliRunResult {
  args: string[];
  buildRegistrations: NextProductCliBuildRegistration[];
  cwd: string;
  serverRegistrations: NextProductCliServerRegistration[];
}

export interface NextRealCliReadiness {
  status: "ready" | "blocked";
  cliEntrypoint: string;
  cliEntryReadiness: CliEntryReadiness;
  cliModuleGraph: CliModuleGraph;
  nextPackageSource: NextProductPackageSource;
}

export interface NextPackageManifest {
  bin?: string | Record<string, string>;
  name?: string;
  version?: string;
}

export interface NextProductPreviewResult {
  statusCode: number;
  headers?: Record<string, string>;
  body: string;
}

export interface NextProductBuildResult {
  files: string[];
  distSmoke: string;
  command: string;
  cliEntrypoint: string | null;
}

export interface NextProductDevServerSnapshot {
  port: number;
  running: boolean;
  restartCount: number;
  requests: string[];
  command: string | null;
  source: "package-script" | "adapter" | "cli-execution";
  cliEntrypoint: string | null;
  processPid: number | null;
  processStarted: boolean;
  processExited: boolean;
  moduleTransform: "adapter" | "next-cli";
}

export interface NextProductSourceEditResult {
  before: string;
  after: string;
  path: string;
  update: ViteProductHmrUpdate;
  statePreserved: boolean;
}

/**
 * Next.js App Router workflow with both the lightweight preview adapter and
 * mounted-distribution CLI execution. Real CLI execution uses the package's
 * version-matched WASM SWC path; native `.node` addons remain unsupported.
 */
export class NextProductWorkflow {
  readonly manager: NextProductPackageManager;
  readonly template = "next-app" as const;
  readonly projectId: string;
  readonly projectRoot: string;
  readonly network: LoopbackNetwork;
  readonly workspace: MemoryPackageManagerWorkspace;
  readonly nextPackageArtifact: NextProductPackageArtifact | null;
  readonly dependencyArtifacts: NextProductDependencyArtifact[];

  #port: number;
  #running = false;
  #restartCount = 0;
  #requests: string[] = [];
  #devServerCommand: string | null = null;
  #devServerSource: NextProductDevServerSnapshot["source"] = "adapter";
  #devServerCliEntrypoint: string | null = null;
  #moduleTransform: NextProductDevServerSnapshot["moduleTransform"] = "adapter";
  #devProcess: RuntimeChildProcess | null = null;
  #cliDispose: (() => void) | null = null;
  #hmrSockets = new Set<ViteProductHmrSocket>();
  #hmrUpdates: ViteProductHmrUpdate[] = [];
  #listener: { close(): void } | null = null;

  constructor(options: NextProductWorkflowOptions) {
    this.manager = options.manager;
    this.projectId = options.projectId || "next-app";
    this.projectRoot = options.projectRoot || "/workspace/app";
    this.network = options.network || createLoopbackNetwork();
    this.nextPackageArtifact = options.nextPackageArtifact || null;
    this.dependencyArtifacts = options.dependencyArtifacts || [];
    this.#port = options.port ?? 3000;
    this.workspace = new MemoryPackageManagerWorkspace(
      createNextMounts(this.projectRoot, options.initialTitle || "Next.js")
    );
  }

  install(): NextProductInstallResult {
    this.#installNextPackage();
    if (!this.#hasDependencyArtifact("react")) this.#installFixturePackage("react");
    if (!this.#hasDependencyArtifact("react-dom")) this.#installFixturePackage("react-dom");
    this.#installDependencyArtifacts();
    return {
      packages: [...new Set(["next", "react", "react-dom", ...this.dependencyArtifacts.map((artifact) => artifact.name)])],
      manager: this.manager,
      nextPackageSource: this.nextPackageArtifact ? "mounted-artifact" : "stub"
    };
  }

  inspectRealCliReadiness(): NextRealCliReadiness {
    if (!this.workspace.exists(join(this.projectRoot, "node_modules/.bin/next"))) this.install();
    const cliEntrypoint = this.#resolveBin("next");
    const cliEntryReadiness = inspectCliEntryReadiness({
      entry: {
        name: "next",
        version: this.#readNextPackageManifest().version || this.nextPackageArtifact?.version || "unknown",
        entry: cliEntrypoint,
        mode: "cjs"
      },
      reader: this.workspace,
      supportedModes: ["cjs", "esm"]
    });
    const cliModuleGraph = analyzeCliModuleGraph({
      entry: cliEntrypoint,
      packageRoot: join(this.projectRoot, "node_modules/next"),
      reader: this.workspace,
      maxModules: 2048
    });
    return {
      status: cliEntryReadiness.status === "ready" && cliModuleGraph.supported ? "ready" : "blocked",
      cliEntrypoint,
      cliEntryReadiness,
      cliModuleGraph,
      nextPackageSource: this.nextPackageArtifact ? "mounted-artifact" : "stub"
    };
  }

  async executeRealCli(args: string[], env: RuntimeEnv = {}): Promise<NextProductCliExecutionResult> {
    if (!this.workspace.exists(join(this.projectRoot, "node_modules/.bin/next"))) this.install();
    const cliEntrypoint = this.#resolveBin("next");
    const serverRegistrations: NextProductCliServerRegistration[] = [];
    const buildRegistrations: NextProductCliBuildRegistration[] = [];
    const portsBeforeExecution = new Set(this.network.listeners.keys());
    let readOutput = () => ({ stderr: "", stdout: "" });
    const command = args[0];
    const runsNativeBuild = command === "build"
      && this.workspace.exists(join(this.projectRoot, "node_modules/next/dist/build/index.js"));
    const result = await createAsyncCliModuleEvaluator({
      ...(runsNativeBuild ? { exitTimeoutMs: 120_000, waitForExit: true } : {}),
      loopbackNetwork: this.network,
      onOutputSnapshot(snapshot) {
        readOutput = snapshot;
      },
      reader: this.workspace,
      settleTimeoutMs: 1_000,
      writer: this.workspace,
      root: this.projectRoot,
      globals: {
        __nextRegisterDevServer(registration: NextProductCliServerRegistration) {
          serverRegistrations.push(registration);
        },
        __nextRegisterBuild(registration: NextProductCliBuildRegistration) {
          buildRegistrations.push(registration);
        }
      }
    })({
      entry: {
        name: "next",
        version: this.#readNextPackageManifest().version || this.nextPackageArtifact?.version || "unknown",
        entry: cliEntrypoint,
        mode: "cjs"
      },
      args,
      cwd: this.projectRoot,
      env
    });
    if ((command === "dev" || command === "start") && serverRegistrations.length === 0) {
      const port = [...this.network.listeners.keys()].find((candidate) => !portsBeforeExecution.has(candidate));
      if (port !== undefined) {
        serverRegistrations.push({ command, host: "127.0.0.1", port, source: "next-cli" });
      }
    }
    const execution = {
      ...result,
      args,
      buildRegistrations,
      cwd: this.projectRoot,
      serverRegistrations
    };
    Object.defineProperties(execution, {
      dispose: { value: result.dispose },
      stderr: { enumerable: true, get: () => readOutput().stderr },
      stdout: { enumerable: true, get: () => readOutput().stdout }
    });
    return execution;
  }

  startDevServerFromPackageScript(name = "dev"): NextProductDevServerSnapshot {
    const command = this.#readScript(name);
    assertNextDevCommand(command);
    const cliEntrypoint = this.#resolveCommandEntrypoint(command);
    this.startDevServer();
    this.#devServerCommand = command;
    this.#devServerSource = "package-script";
    this.#devServerCliEntrypoint = cliEntrypoint;
    this.#moduleTransform = "adapter";
    return this.#snapshot();
  }

  async startDevServerFromCliExecution(name = "dev"): Promise<NextProductDevServerSnapshot> {
    const command = this.#readScript(name);
    assertNextDevCommand(command);
    const cliEntrypoint = this.#resolveCommandEntrypoint(command);
    const execution = await this.executeRealCli(commandArgs(command), { PORT: String(this.#port) });
    const registration = execution.serverRegistrations.at(-1);
    if (!registration || registration.command !== "dev") {
      execution.dispose?.();
      throw new Error(execution.stderr || "ERR_NEXT_CLI_SERVER_REGISTRATION_MISSING");
    }
    this.#port = registration.port;
    this.#cliDispose = execution.dispose || null;
    const usesNativeCliServer = this.network.listeners.has(registration.port);
    if (usesNativeCliServer) this.#adoptCliServer(registration.port);
    else this.startDevServer();
    this.#devServerCommand = command;
    this.#devServerSource = "cli-execution";
    this.#devServerCliEntrypoint = cliEntrypoint;
    this.#moduleTransform = usesNativeCliServer ? "next-cli" : "adapter";
    return this.#snapshot();
  }

  async startProductionServerFromCliExecution(name = "start"): Promise<NextProductDevServerSnapshot> {
    const command = this.#readScript(name);
    assertNextStartCommand(command);
    const cliEntrypoint = this.#resolveCommandEntrypoint(command);
    const execution = await this.executeRealCli(commandArgs(command), { PORT: String(this.#port) });
    const registration = execution.serverRegistrations.at(-1);
    if (!registration || registration.command !== "start") {
      execution.dispose?.();
      throw new Error(execution.stderr || "ERR_NEXT_CLI_PRODUCTION_SERVER_REGISTRATION_MISSING");
    }
    this.#port = registration.port;
    this.#cliDispose = execution.dispose || null;
    const usesNativeCliServer = this.network.listeners.has(registration.port);
    if (usesNativeCliServer) this.#adoptCliServer(registration.port);
    else this.startDevServer();
    this.#devServerCommand = command;
    this.#devServerSource = "cli-execution";
    this.#devServerCliEntrypoint = cliEntrypoint;
    this.#moduleTransform = usesNativeCliServer ? "next-cli" : "adapter";
    return this.#snapshot();
  }

  startDevServer(): NextProductDevServerSnapshot {
    if (this.#running) return this.#snapshot();
    const listenPort = this.#port;
    this.#listener = this.network.listen(listenPort, async (request) => {
      const origin = "http://127.0.0.1:" + String(listenPort);
      const url = new URL(request.path || "/", origin);
      this.#requests.push(url.pathname);
      return toRuntimeHttpResponse(this.preview(url.pathname + url.search));
    });
    this.#devProcess = spawnRuntimeChild({
      pid: listenPort,
      entrypoint: ({ scheduler, stdio }) => {
        stdio.stdout.write(new TextEncoder().encode(`next server listening on 127.0.0.1:${listenPort}\n`));
        scheduler.liveness.ref("next-dev-server");
      }
    });
    void this.#devProcess.scheduler.drainMicrotasks();
    this.#running = true;
    return this.#snapshot();
  }

  stopDevServer(): NextProductDevServerSnapshot {
    this.#listener?.close();
    this.#listener = null;
    this.#running = false;
    this.#devProcess?.process.exit(143);
    this.#cliDispose?.();
    this.#cliDispose = null;
    return this.#snapshot();
  }

  #adoptCliServer(port: number): void {
    this.#listener = {
      close: () => {
        const listener = this.network.listeners.get(port);
        if (listener) listener.closed = true;
        this.network.listeners.delete(port);
      }
    };
    this.#running = true;
  }

  restart(): { restarted: boolean; previewAfterRestart: string } {
    const command = this.#devServerCommand;
    const source = this.#devServerSource;
    const cliEntrypoint = this.#devServerCliEntrypoint;
    const moduleTransform = this.#moduleTransform;
    this.stopDevServer();
    this.#restartCount += 1;
    this.startDevServer();
    this.#devServerCommand = command || "next dev";
    this.#devServerSource = source;
    this.#devServerCliEntrypoint = cliEntrypoint;
    this.#moduleTransform = moduleTransform;
    return {
      restarted: true,
      previewAfterRestart: this.preview("/").body
    };
  }

  preview(path = "/"): NextProductPreviewResult {
    if (!this.#running) return { statusCode: 503, body: "dev server unavailable" };
    const queryIndex = path.indexOf("?");
    const requestPath = normalizeRoutePath((queryIndex >= 0 ? path.slice(0, queryIndex) : path) || "/");
    const query = queryIndex >= 0 ? path.slice(queryIndex + 1) : "";
    if (new URLSearchParams(query).get("nuriteo-module") === "json") {
      const workspacePath = this.#resolveServedWorkspacePath(requestPath);
      if (!workspacePath?.endsWith(".json")) return { statusCode: 404, body: "Not found" };
      try {
        return {
          statusCode: 200,
          headers: { "content-type": "text/javascript; charset=utf-8" },
          body: previewJsonModuleSource(this.workspace.readText(workspacePath))
        };
      } catch {
        return { statusCode: 500, body: "Invalid JSON module" };
      }
    }
    if (requestPath === "/_next/static/chunks/app.js") {
      return this.#serveAppBootstrap();
    }
    if (requestPath === "/app/layout.js" || requestPath === "/app/layout.tsx") {
      return this.#serveLayoutModule();
    }
    if (requestPath.startsWith("/node_modules/") || requestPath.startsWith("/app/") || requestPath.startsWith("/src/")) {
      const served = this.#readServedSource(requestPath);
      if (served) return served;
      return { statusCode: 404, body: "Not found" };
    }
    if (requestPath === "/index.html") {
      return {
        statusCode: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
        body: this.#renderDocument("/")
      };
    }
    // App Router HTML shell for `/`, `/about`, etc.
    if (this.#resolvePagePathForRoute(requestPath)) {
      return {
        statusCode: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
        body: this.#renderDocument(requestPath)
      };
    }
    const served = this.#readServedSource(requestPath);
    if (served) return served;
    return { statusCode: 404, body: "Not found" };
  }

  applySourceEdit(path: string, data: string): NextProductSourceEditResult {
    const requestPath = normalizeServedPath(path);
    const before = this.preview("/").body;
    this.workspace.writeText(join(this.projectRoot, requestPath), data);
    const after = this.preview("/").body;
    const update = createViteHmrUpdate(requestPath, hmrLabelForSource(requestPath, data));
    this.#hmrUpdates.push(update);
    this.#broadcastHmr(update);
    return {
      before,
      after,
      path: requestPath,
      update,
      statePreserved: true
    };
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
      if (this.#hmrSockets.has(socket)) {
        socket.onmessage?.({ data: JSON.stringify({ type: "connected" }) });
      }
    });
    return socket;
  }

  hmrUpdates(): ViteProductHmrUpdate[] {
    return [...this.#hmrUpdates];
  }

  buildFromPackageScript(name = "build"): NextProductBuildResult {
    const command = this.#readScript(name);
    assertNextBuildCommand(command);
    return this.#build(command, this.#resolveCommandEntrypoint(command));
  }

  async buildFromCliExecution(name = "build"): Promise<NextProductBuildResult> {
    const command = this.#readScript(name);
    assertNextBuildCommand(command);
    const cliEntrypoint = this.#resolveCommandEntrypoint(command);
    const execution = await this.executeRealCli(commandArgs(command));
    try {
      if (execution.exitCode !== 0) {
        throw new Error(execution.stderr || `next build exited with code ${execution.exitCode}`);
      }
      if (this.workspace.exists(join(this.projectRoot, ".next/BUILD_ID"))) {
        return this.#nativeBuild(command, cliEntrypoint);
      }
      if (!execution.buildRegistrations.some((registration) => registration.command === "build")) {
        throw new Error(execution.stderr || "ERR_NEXT_CLI_BUILD_REGISTRATION_MISSING");
      }
      return this.#build(command, cliEntrypoint);
    } finally {
      execution.dispose?.();
    }
  }

  #nativeBuild(command: string, cliEntrypoint: string): NextProductBuildResult {
    const outputRoot = join(this.projectRoot, ".next");
    const prefix = `${this.projectRoot}/`;
    const files = [...this.workspace.files.keys()]
      .filter((path) => path === outputRoot || path.startsWith(`${outputRoot}/`))
      .map((path) => path.startsWith(prefix) ? path.slice(prefix.length) : path)
      .sort();
    const indexHtml = join(outputRoot, "server/app/index.html");
    return {
      files,
      distSmoke: this.workspace.exists(indexHtml) ? this.workspace.readText(indexHtml) : "",
      command,
      cliEntrypoint
    };
  }

  #build(command: string, cliEntrypoint: string): NextProductBuildResult {
    const html = this.#renderDocument("/");
    this.workspace.mkdir(join(this.projectRoot, "out"));
    this.workspace.writeText(join(this.projectRoot, "out/index.html"), html);
    this.workspace.writeText(
      join(this.projectRoot, "out/_next/static/chunks/app.js"),
      this.#serveAppBootstrap().body
    );
    return {
      files: ["out/index.html", "out/_next/static/chunks/app.js"],
      distSmoke: html,
      command,
      cliEntrypoint
    };
  }

  async fetch(input: string | URL, options: LoopbackFetchOptions = {}): Promise<Response> {
    const response = await this.network.fetch(input, options);
    const init: ResponseInit = { status: response.statusCode };
    if (response.statusText) init.statusText = response.statusText;
    if (response.headers) init.headers = response.headers;
    return new Response(toResponseBody(response.body), init);
  }

  #snapshot(): NextProductDevServerSnapshot {
    return {
      port: this.#port,
      running: this.#running,
      restartCount: this.#restartCount,
      requests: [...this.#requests],
      command: this.#devServerCommand,
      source: this.#devServerSource,
      cliEntrypoint: this.#devServerCliEntrypoint,
      processPid: this.#devProcess?.process.pid ?? (this.#devServerSource === "cli-execution" ? this.#port : null),
      processStarted: this.#devProcess?.started ?? (this.#devServerSource === "cli-execution" && this.#devServerCommand !== null),
      processExited: this.#devProcess?.process.exited ?? (this.#devServerSource === "cli-execution" && this.#devServerCommand !== null && !this.#running),
      moduleTransform: this.#moduleTransform
    };
  }

  #readScript(name: string): string {
    const manifest = JSON.parse(this.workspace.readText(join(this.projectRoot, "package.json"))) as {
      scripts?: Record<string, string>;
    };
    const command = manifest.scripts?.[name];
    if (!command) throw new Error(`missing package script: ${name}`);
    return command;
  }

  #renderDocument(routePath = "/"): string {
    const title = this.#readTitle(routePath);
    const pagePath = this.#resolvePagePathForRoute(routePath);
    const pageModule = pagePath
      ? pagePath.slice(this.projectRoot.length).replace(/\.(?:tsx?|jsx)$/u, ".js")
      : null;
    const globalsHref = this.workspace.exists(join(this.projectRoot, "app/globals.css"))
      ? '<link rel="stylesheet" href="/app/globals.css" />'
      : "";
    const importMap = JSON.stringify({
      imports: {
        react: "/node_modules/react/index.js",
        "react-dom": "/node_modules/react-dom/client.js",
        "react-dom/client": "/node_modules/react-dom/client.js",
        "react/jsx-runtime": "/node_modules/react/jsx-runtime.js",
        "react/jsx-dev-runtime": "/node_modules/react/jsx-runtime.js",
        next: "/node_modules/next/index.js",
        "next/link": "/node_modules/next/link.js",
        "next/navigation": "/node_modules/next/navigation.js",
        "next/image": "/node_modules/next/image.js"
      }
    });
    return [
      "<!doctype html>",
      "<html lang=\"en\">",
      "<head>",
      "<meta charset=\"UTF-8\" />",
      `<title>${escapeHtml(title)}</title>`,
      `<script type="importmap">${importMap}</script>`,
      globalsHref,
      "<style>body{margin:0;font-family:system-ui,sans-serif}#app,#root{min-height:100vh}a{color:#2563eb}</style>",
      "</head>",
      "<body>",
      `<div id="app"><main><h1>${escapeHtml(title)}</h1><p>Next.js Preview</p></main></div>`,
      `<script>window.__NEXT_PREVIEW_ROUTE__=${JSON.stringify(routePath)};</script>`,
      `<script>window.__NEXT_PREVIEW_PAGE_MODULE__=${JSON.stringify(pageModule)};</script>`,
      "<script type=\"module\" src=\"/_next/static/chunks/app.js\"></script>",
      "</body></html>"
    ].join("");
  }

  #serveAppBootstrap(): NextProductPreviewResult {
    return {
      statusCode: 200,
      headers: { "content-type": "text/javascript; charset=utf-8" },
      body: buildAppRouterBootstrap()
    };
  }

  #serveLayoutModule(): NextProductPreviewResult {
    const layoutPath = join(this.projectRoot, "app/layout.tsx");
    if (!this.workspace.exists(layoutPath)) {
      return {
        statusCode: 200,
        headers: { "content-type": "text/javascript; charset=utf-8" },
        body: "export default function RootLayout({ children }) { return children; }\n"
      };
    }
    return {
      statusCode: 200,
      headers: { "content-type": "text/javascript; charset=utf-8" },
      body: transformModule(layoutPath, this.workspace.readText(layoutPath), (specifier) => this.#resolvePreviewSpecifier(specifier), {
        importerPath: layoutPath,
        projectRoot: this.projectRoot,
        workspace: this.workspace
      })
    };
  }

  #resolvePagePathForRoute(routePath: string): string | null {
    const normalized = normalizeRoutePath(routePath);
    const candidates = normalized === "/"
      ? ["app/page.tsx", "app/page.jsx", "app/page.js", "pages/index.tsx", "pages/index.jsx", "pages/index.js"]
      : [
        `app${normalized}/page.tsx`,
        `app${normalized}/page.jsx`,
        `app${normalized}/page.js`,
        `pages${normalized}.tsx`,
        `pages${normalized}.jsx`,
        `pages${normalized}.js`
      ];
    for (const relative of candidates) {
      const absolute = join(this.projectRoot, relative);
      if (this.workspace.exists(absolute)) return absolute;
    }
    return null;
  }

  #resolvePagePath(): string {
    const page = this.#resolvePagePathForRoute("/");
    if (!page) throw new Error("No Next.js page entry found (expected app/page.tsx)");
    return page;
  }

  #resolvePreviewSpecifier(specifier: string): string | undefined {
    return resolveInstalledPreviewSpecifier(this.projectRoot, specifier, this.workspace);
  }

  #readTitle(routePath = "/"): string {
    try {
      const pagePath = this.#resolvePagePathForRoute(routePath) || this.#resolvePagePath();
      const page = this.workspace.readText(pagePath);
      return page.match(/<h1[^>]*>([^<]+)<\/h1>/)?.[1]
        || page.match(/title:\s*["']([^"']+)["']/)?.[1]
        || "Next.js";
    } catch {
      return "Next.js";
    }
  }

  #readServedSource(requestPath: string): NextProductPreviewResult | null {
    const workspacePath = this.#resolveServedWorkspacePath(requestPath);
    if (!workspacePath) return null;
    const body = this.workspace.readText(workspacePath);
    const transformPath = workspacePath.slice(this.projectRoot.length) || requestPath;
    return {
      statusCode: 200,
      headers: { "content-type": contentTypeForPath(requestPath) },
      body: transformServedModule(transformPath, body, (specifier) => this.#resolvePreviewSpecifier(specifier), {
        importerPath: workspacePath,
        projectRoot: this.projectRoot,
        workspace: this.workspace
      })
    };
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

  #installNextPackage(): void {
    if (!this.nextPackageArtifact) {
      this.#installFixturePackage("next");
      return;
    }
    const packageRoot = join(this.projectRoot, "node_modules/next");
    for (const mount of this.nextPackageArtifact.mounts) {
      const path = join(packageRoot, normalizePackageArtifactPath(mount.path));
      if (mount.encoding === "base64") {
        this.workspace.writeBytes(path, decodeBase64(mount.data));
      } else {
        this.workspace.writeText(path, mount.data);
      }
    }
    const manifestPath = join(packageRoot, "package.json");
    if (!this.workspace.exists(manifestPath)) {
      throw new Error(`Mounted Next.js package artifact must include package.json: ${manifestPath}`);
    }
    const manifest = this.#readNextPackageManifest();
    if (manifest.name !== "next") {
      throw new Error(`Mounted Next.js package artifact package.json must have name "next": ${manifestPath}`);
    }
    const binPath = join(packageRoot, readNextPackageBinPath(manifest));
    if (!this.workspace.exists(binPath)) {
      throw new Error(`Mounted Next.js package artifact bin entry is missing: ${binPath}`);
    }
    this.workspace.symlink(binPath, join(this.projectRoot, "node_modules/.bin/next"));
  }

  #readNextPackageManifest(): NextPackageManifest {
    return JSON.parse(
      this.workspace.readText(join(this.projectRoot, "node_modules/next/package.json"))
    ) as NextPackageManifest;
  }

  #installDependencyArtifacts(): void {
    for (const artifact of this.dependencyArtifacts) {
      const packageRoot = join(this.projectRoot, "node_modules", artifact.name);
      for (const mount of artifact.mounts) {
        const path = join(packageRoot, normalizePackageArtifactPath(mount.path));
        if (mount.encoding === "base64") this.workspace.writeBytes(path, decodeBase64(mount.data));
        else this.workspace.writeText(path, mount.data);
      }
      const manifestPath = join(packageRoot, "package.json");
      if (!this.workspace.exists(manifestPath)) {
        throw new Error(`Mounted dependency artifact ${artifact.name} must include package.json: ${manifestPath}`);
      }
      const manifest = JSON.parse(this.workspace.readText(manifestPath)) as NextPackageManifest;
      if (manifest.name !== artifact.name) {
        throw new Error(`Mounted dependency artifact package.json must have name "${artifact.name}": ${manifestPath}`);
      }
    }
  }

  #hasDependencyArtifact(name: string): boolean {
    return this.dependencyArtifacts.some((artifact) => artifact.name === name);
  }

  #shouldKeepInstalledPackage(pkg: string): boolean {
    return shouldKeepInstalledPackage(this.workspace, join(this.projectRoot, "node_modules", pkg, "package.json"));
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

  #installFixturePackage(pkg: string): void {
    if (this.#shouldKeepInstalledPackage(pkg)) return;
    const packageRoot = join(this.projectRoot, "node_modules", pkg);
    if (pkg === "next") {
      this.workspace.writeText(join(packageRoot, "package.json"), JSON.stringify({
        name: "next",
        nuriteoFixture: true,
        version: "15.5.26",
        type: "module",
        bin: { next: "dist/bin/next.cjs" },
        exports: {
          ".": "./index.js",
          "./link": "./link.js",
          "./navigation": "./navigation.js",
          "./image": "./image.js"
        }
      }));
      this.workspace.writeText(
        join(packageRoot, "dist/bin/next.cjs"),
        [
          "const command = process.argv[2] || 'dev';",
          "const port = Number(process.env.PORT || 3000);",
          "if (command === 'build') global.__nextRegisterBuild?.({ command: 'build', outputDirectory: '.next', source: 'next-cli' });",
          "else global.__nextRegisterDevServer?.({ command: command === 'start' ? 'start' : 'dev', host: '127.0.0.1', port, source: 'next-cli' });",
          ""
        ].join("\n")
      );
      this.workspace.symlink(join(packageRoot, "dist/bin/next.cjs"), join(this.projectRoot, "node_modules/.bin/next"));
      this.workspace.writeText(join(packageRoot, "index.js"), "export default {};\n");
      this.workspace.writeText(
        join(packageRoot, "link.js"),
        [
          "import { jsx as _jsx } from \"react/jsx-runtime\";",
          "function previewBase() {",
          "  const match = location.pathname.match(/^(.*?\\/__preview\\/[^/]+\\/\\d+)/);",
          "  return match ? match[1] : \"\";",
          "}",
          "export default function Link({ href = \"#\", children, ...props }) {",
          "  return _jsx(\"a\", {",
          "    ...props,",
          "    href,",
          "    children,",
          "    onClick(event) {",
          "      if (props.onClick) props.onClick(event);",
          "      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;",
          "      if (typeof href !== \"string\" || href.startsWith(\"http\") || href.startsWith(\"mailto:\")) return;",
          "      event.preventDefault();",
          "      const base = previewBase();",
          "      const next = href.startsWith(\"/\") ? href : `/${href}`;",
          "      location.assign(`${base}${next}${location.search}`);",
          "    }",
          "  });",
          "}",
          ""
        ].join("\n")
      );
      this.workspace.writeText(
        join(packageRoot, "navigation.js"),
        [
          "function previewBase() {",
          "  const match = location.pathname.match(/^(.*?\\/__preview\\/[^/]+\\/\\d+)/);",
          "  return match ? match[1] : \"\";",
          "}",
          "function currentRoute() {",
          "  const match = location.pathname.match(/\\/__preview\\/[^/]+\\/\\d+(\\/.*)?$/);",
          "  return match && match[1] ? match[1] : \"/\";",
          "}",
          "export function useRouter() {",
          "  return {",
          "    push(href) { location.assign(`${previewBase()}${href.startsWith(\"/\") ? href : `/${href}`}${location.search}`); },",
          "    replace(href) { location.replace(`${previewBase()}${href.startsWith(\"/\") ? href : `/${href}`}${location.search}`); },",
          "    back() { history.back(); },",
          "    prefetch() {}",
          "  };",
          "}",
          "export function usePathname() { return currentRoute(); }",
          "export function useSearchParams() { return new URLSearchParams(location.search); }",
          ""
        ].join("\n")
      );
      this.workspace.writeText(
        join(packageRoot, "image.js"),
        "import { jsx as _jsx } from \"react/jsx-runtime\";\nexport default function Image({ src = \"\", alt = \"\", ...props }) { return _jsx(\"img\", { src, alt, ...props }); }\n"
      );
      return;
    }
    if (pkg === "react") {
      this.workspace.writeText(join(packageRoot, "package.json"), JSON.stringify({
        name: "react",
        nuriteoFixture: true,
        version: "19.0.0",
        type: "module",
        exports: { ".": "./index.js", "./jsx-runtime": "./jsx-runtime.js", "./jsx-dev-runtime": "./jsx-runtime.js" }
      }));
      this.workspace.writeText(join(packageRoot, "index.js"), REACT_SHIM);
      this.workspace.writeText(join(packageRoot, "jsx-runtime.js"), JSX_RUNTIME_SHIM);
      return;
    }
    if (pkg === "react-dom") {
      this.workspace.writeText(join(packageRoot, "package.json"), JSON.stringify({
        name: "react-dom",
        nuriteoFixture: true,
        version: "19.0.0",
        type: "module",
        exports: { ".": "./client.js", "./client": "./client.js" }
      }));
      this.workspace.writeText(join(packageRoot, "client.js"), REACT_DOM_SHIM);
    }
  }

  #broadcastHmr(payload: ViteProductHmrUpdate): void {
    for (const socket of this.#hmrSockets) {
      socket.onmessage?.({ data: JSON.stringify(payload) });
    }
  }
}

