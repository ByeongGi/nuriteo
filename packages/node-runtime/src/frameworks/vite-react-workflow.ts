import { join } from "../builtins/path.ts";
import { spawnRuntimeChild, type RuntimeChildProcess } from "../child-process.ts";
import { createLoopbackNetwork, type LoopbackNetwork, type RuntimeHttpResponse } from "../net/index.ts";
import { MemoryPackageManagerWorkspace, type PackageManagerWorkspaceMount } from "../package-managers/workspace.ts";

export type ViteReactPackageManager = "npm" | "pnpm";

export interface ViteReactProductWorkflowOptions {
  manager: ViteReactPackageManager;
  projectId?: string;
  projectRoot?: string;
  initialLabel?: string;
  network?: LoopbackNetwork;
  port?: number;
}

export interface ViteReactProductWorkflowResult {
  runtime: "browser-guest-node-runtime";
  manager: ViteReactPackageManager;
  projectId: string;
  install: ViteReactInstallResult;
  devServer: ViteReactDevServerSnapshot;
  preview: ViteReactPreviewResult;
  hmr: ViteReactHmrResult;
  build: ViteReactBuildResult;
  reloadRecovery: ViteReactReloadRecoveryResult;
}

export interface ViteReactInstallResult {
  installed: boolean;
  lockfile: string;
  packages: string[];
}

export interface ViteReactDevServerSnapshot {
  port: number;
  running: boolean;
  restartCount: number;
  requests: string[];
  command: string | null;
  source: "adapter" | "package-script";
  cliEntrypoint: string | null;
  processPid: number | null;
  processStarted: boolean;
  processExited: boolean;
}

export interface ViteReactHmrUpdate {
  type: "update";
  path: string;
  label: string;
}

export interface ViteReactPreviewResult {
  statusCode: number;
  body: string;
}

export interface ViteReactHmrResult {
  before: string;
  after: string;
  statePreserved: boolean;
}

export interface ViteReactBuildResult {
  files: string[];
  distSmoke: string;
  command: string | null;
  cliEntrypoint: string | null;
}

export interface ViteReactReloadRecoveryResult {
  restarted: boolean;
  previewAfterRestart: string;
}

export class ViteReactProductWorkflow {
  readonly manager: ViteReactPackageManager;
  readonly projectId: string;
  readonly projectRoot: string;
  readonly workspace: MemoryPackageManagerWorkspace;
  readonly network: LoopbackNetwork;
  #state = { count: 1 };
  #port: number;
  #restartCount = 0;
  #running = false;
  #listener: { port: number; close: () => void } | null = null;
  #devProcess: RuntimeChildProcess | null = null;
  #devServerCommand: string | null = null;
  #devServerSource: "adapter" | "package-script" = "adapter";
  #devServerCliEntrypoint: string | null = null;
  #buildCommand: string | null = null;
  #buildCliEntrypoint: string | null = null;
  #requests: string[] = [];
  #hmrUpdates: ViteReactHmrUpdate[] = [];

  constructor(options: ViteReactProductWorkflowOptions) {
    this.manager = options.manager;
    this.projectId = options.projectId || `vite-react-${options.manager}`;
    this.projectRoot = options.projectRoot || "/workspace/project";
    this.network = options.network || createLoopbackNetwork();
    this.#port = options.port ?? 5173;
    this.workspace = new MemoryPackageManagerWorkspace(createViteReactMounts(this.projectRoot, options.initialLabel || "alpha"));
  }

  run(): ViteReactProductWorkflowResult {
    const install = this.install();
    const devServer = this.startDevServerFromPackageScript();
    const preview = this.preview("/");
    const hmr = this.editMessage("beta");
    const build = this.buildFromPackageScript();
    const reloadRecovery = this.restart();
    return {
      runtime: "browser-guest-node-runtime",
      manager: this.manager,
      projectId: this.projectId,
      install,
      devServer,
      preview,
      hmr,
      build,
      reloadRecovery
    };
  }

  install(): ViteReactInstallResult {
    const packages = ["@vitejs/plugin-react", "vite", "typescript", "react", "react-dom"];
    for (const pkg of packages) {
      this.workspace.writeText(join(this.projectRoot, "node_modules", pkg, "package.json"), JSON.stringify({ name: pkg }));
    }
    this.#installViteCliEntrypoint();
    const lockfile = this.manager === "npm" ? "package-lock.json" : "pnpm-lock.yaml";
    this.workspace.writeText(join(this.projectRoot, lockfile), createLockfile(this.manager, packages));
    return { installed: true, lockfile, packages };
  }

  startDevServer(): ViteReactDevServerSnapshot {
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

  startDevServerFromPackageScript(name = "dev"): ViteReactDevServerSnapshot {
    const command = this.#readScript(name);
    assertViteDevCommand(command);
    const cliEntrypoint = this.#resolveCommandEntrypoint(command);
    this.startDevServer();
    this.#devServerSource = "package-script";
    this.#devServerCommand = command;
    this.#devServerCliEntrypoint = cliEntrypoint;
    return this.#snapshot();
  }

  stopDevServer(): ViteReactDevServerSnapshot {
    this.#listener?.close();
    this.#listener = null;
    this.#running = false;
    this.#devProcess?.process.exit(143);
    return this.#snapshot();
  }

  preview(path = "/"): ViteReactPreviewResult {
    if (!this.#running) return { statusCode: 503, body: "dev server unavailable" };
    if (path !== "/" && path !== "/index.html") return { statusCode: 404, body: "Not found" };
    return {
      statusCode: 200,
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

  editMessage(label: string): ViteReactHmrResult {
    const before = this.preview("/").body;
    this.workspace.writeText(join(this.projectRoot, "src/message.js"), `export const label = "${label}";\n`);
    const after = this.preview("/").body;
    this.#hmrUpdates.push({ type: "update", path: "/src/message.js", label });
    return {
      before,
      after,
      statePreserved: before.includes(`:${this.#state.count}`) && after.includes(`:${this.#state.count}`)
    };
  }

  hmrUpdates(): ViteReactHmrUpdate[] {
    return [...this.#hmrUpdates];
  }

  build(): ViteReactBuildResult {
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

  buildFromPackageScript(name = "build"): ViteReactBuildResult {
    const command = this.#readScript(name);
    assertViteBuildCommand(command);
    this.#buildCommand = command;
    this.#buildCliEntrypoint = this.#resolveCommandEntrypoint(command);
    return this.build();
  }

  restart(): ViteReactReloadRecoveryResult {
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

  #snapshot(): ViteReactDevServerSnapshot {
    return {
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

  #installViteCliEntrypoint(): void {
    const packageJsonPath = join(this.projectRoot, "node_modules/vite/package.json");
    this.workspace.writeText(packageJsonPath, JSON.stringify({ name: "vite", version: "8.2.0", bin: { vite: "bin/vite.js" } }));
    this.workspace.writeText(join(this.projectRoot, "node_modules/vite/bin/vite.js"), "#!/usr/bin/env node\nimport '../dist/node/cli.js';\n");
    this.workspace.symlink(join(this.projectRoot, "node_modules/vite/bin/vite.js"), join(this.projectRoot, "node_modules/.bin/vite"));
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
}

export function runViteReactProductWorkflow(options: ViteReactProductWorkflowOptions): ViteReactProductWorkflowResult {
  return new ViteReactProductWorkflow(options).run();
}

function createViteReactMounts(projectRoot: string, label: string): PackageManagerWorkspaceMount[] {
  return [
    {
      path: join(projectRoot, "package.json"),
      data: JSON.stringify({
        name: "vite-react-product-workflow",
        version: "1.0.0",
        private: true,
        type: "module",
        scripts: {
          dev: "vite --host 127.0.0.1",
          build: "vite build",
          preview: "vite preview --host 127.0.0.1"
        },
        dependencies: {
          "@vitejs/plugin-react": "latest",
          vite: "8.2.0",
          typescript: "6.0.3",
          react: "18.3.1",
          "react-dom": "18.3.1"
        }
      })
    },
    {
      path: join(projectRoot, "index.html"),
      data: "<div id=\"root\"></div><script type=\"module\" src=\"/src/main.jsx\"></script>\n"
    },
    {
      path: join(projectRoot, "src/main.jsx"),
      data: "import React from \"react\";\nimport { createRoot } from \"react-dom/client\";\nimport { label } from \"./message.js\";\ncreateRoot(document.getElementById(\"root\")).render(`${label}:1`);\n"
    },
    {
      path: join(projectRoot, "src/message.js"),
      data: `export const label = "${label}";\n`
    }
  ];
}

function createLockfile(manager: ViteReactPackageManager, packages: string[]): string {
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

function renderHtml(label: string, count: number): string {
  return `<!doctype html><div id="app">${label}:${count}</div>`;
}

function toRuntimeHttpResponse(preview: ViteReactPreviewResult): RuntimeHttpResponse {
  return {
    statusCode: preview.statusCode,
    headers: { "content-type": "text/html; charset=utf-8" },
    body: preview.body
  };
}

function assertViteDevCommand(command: string): void {
  if (!/^vite(\s|$)/.test(command) || command.includes(" build") || command.includes(" preview")) {
    throw new Error(`unsupported Vite dev command: ${command}`);
  }
}

function assertViteBuildCommand(command: string): void {
  if (command !== "vite build") throw new Error(`unsupported Vite build command: ${command}`);
}
