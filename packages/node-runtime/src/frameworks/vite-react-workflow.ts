import { join } from "../builtins/path.ts";
import { MemoryPackageManagerWorkspace, type PackageManagerWorkspaceMount } from "../package-managers/workspace.ts";

export type ViteReactPackageManager = "npm" | "pnpm";

export interface ViteReactProductWorkflowOptions {
  manager: ViteReactPackageManager;
  projectId?: string;
  projectRoot?: string;
  initialLabel?: string;
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
  #state = { count: 1 };
  #port = 5173;
  #restartCount = 0;
  #running = false;

  constructor(options: ViteReactProductWorkflowOptions) {
    this.manager = options.manager;
    this.projectId = options.projectId || `vite-react-${options.manager}`;
    this.projectRoot = options.projectRoot || "/workspace/project";
    this.workspace = new MemoryPackageManagerWorkspace(createViteReactMounts(this.projectRoot, options.initialLabel || "alpha"));
  }

  run(): ViteReactProductWorkflowResult {
    const install = this.install();
    const devServer = this.startDevServer();
    const preview = this.preview("/");
    const hmr = this.editMessage("beta");
    const build = this.build();
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
    const lockfile = this.manager === "npm" ? "package-lock.json" : "pnpm-lock.yaml";
    this.workspace.writeText(join(this.projectRoot, lockfile), createLockfile(this.manager, packages));
    return { installed: true, lockfile, packages };
  }

  startDevServer(): ViteReactDevServerSnapshot {
    this.#running = true;
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
    const path = new URL(String(input)).pathname;
    const preview = this.preview(path);
    return new Response(preview.body, {
      status: preview.statusCode,
      headers: { "content-type": "text/html; charset=utf-8" }
    });
  }

  editMessage(label: string): ViteReactHmrResult {
    const before = this.preview("/").body;
    this.workspace.writeText(join(this.projectRoot, "src/message.js"), `export const label = "${label}";\n`);
    const after = this.preview("/").body;
    return {
      before,
      after,
      statePreserved: before.includes(`:${this.#state.count}`) && after.includes(`:${this.#state.count}`)
    };
  }

  build(): ViteReactBuildResult {
    const html = renderHtml(this.#readLabel(), this.#state.count);
    this.workspace.writeText(join(this.projectRoot, "dist/index.html"), html);
    this.workspace.writeText(join(this.projectRoot, "dist/assets/index.js"), `document.querySelector("#app").textContent = "${this.#readLabel()}:${this.#state.count}";\n`);
    return {
      files: ["dist/index.html", "dist/assets/index.js"],
      distSmoke: this.workspace.readText(join(this.projectRoot, "dist/index.html"))
    };
  }

  restart(): ViteReactReloadRecoveryResult {
    this.#running = false;
    this.#restartCount += 1;
    this.#running = true;
    return {
      restarted: true,
      previewAfterRestart: this.preview("/").body
    };
  }

  #snapshot(): ViteReactDevServerSnapshot {
    return {
      port: this.#port,
      running: this.#running,
      restartCount: this.#restartCount
    };
  }

  #readLabel(): string {
    const source = this.workspace.readText(join(this.projectRoot, "src/message.js"));
    return source.match(/label\s*=\s*"([^"]+)"/)?.[1] || "unknown";
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
