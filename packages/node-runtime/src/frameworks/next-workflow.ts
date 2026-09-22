import { join } from "../builtins/path.ts";
import { createLoopbackNetwork, type LoopbackNetwork, type RuntimeHttpResponse } from "../net/index.ts";
import { MemoryPackageManagerWorkspace } from "../package-managers/workspace.ts";
import { transpileTypeScript } from "../transforms/typescript.ts";
import { createViteHmrUpdate, type ViteProductHmrSocket, type ViteProductHmrUpdate } from "./vite-workflow.ts";

export type NextProductPackageManager = "npm" | "pnpm";

export interface NextProductWorkflowOptions {
  manager: NextProductPackageManager;
  projectId?: string;
  projectRoot?: string;
  initialTitle?: string;
  network?: LoopbackNetwork;
  port?: number;
}

export interface NextProductInstallResult {
  packages: string[];
  manager: NextProductPackageManager;
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
  source: "package-script" | "adapter";
  cliEntrypoint: string | null;
  processPid: number | null;
  processStarted: boolean;
  processExited: boolean;
  moduleTransform: "adapter";
}

export interface NextProductSourceEditResult {
  before: string;
  after: string;
  path: string;
  update: ViteProductHmrUpdate;
  statePreserved: boolean;
}

/**
 * Next.js App Router product preview adapter.
 * Supports multi-route app page entries, root layout wrapping, and next/link
 * client navigation inside the preview iframe. Native SWC / full RSC remain out of scope.
 */
export class NextProductWorkflow {
  readonly manager: NextProductPackageManager;
  readonly template = "next-app" as const;
  readonly projectId: string;
  readonly projectRoot: string;
  readonly network: LoopbackNetwork;
  readonly workspace: MemoryPackageManagerWorkspace;

  #port: number;
  #running = false;
  #restartCount = 0;
  #requests: string[] = [];
  #devServerCommand: string | null = null;
  #hmrSockets = new Set<ViteProductHmrSocket>();
  #hmrUpdates: ViteProductHmrUpdate[] = [];
  #listener: { close(): void } | null = null;

  constructor(options: NextProductWorkflowOptions) {
    this.manager = options.manager;
    this.projectId = options.projectId || "next-app";
    this.projectRoot = options.projectRoot || "/workspace/app";
    this.network = options.network || createLoopbackNetwork();
    this.#port = options.port ?? 3000;
    this.workspace = new MemoryPackageManagerWorkspace(
      createNextMounts(this.projectRoot, options.initialTitle || "Next.js")
    );
  }

  install(): NextProductInstallResult {
    this.#installFixturePackage("next");
    this.#installFixturePackage("react");
    this.#installFixturePackage("react-dom");
    return {
      packages: ["next", "react", "react-dom"],
      manager: this.manager
    };
  }

  startDevServerFromPackageScript(name = "dev"): NextProductDevServerSnapshot {
    const command = this.#readScript(name);
    assertNextDevCommand(command);
    this.startDevServer();
    this.#devServerCommand = command;
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
    this.#running = true;
    return this.#snapshot();
  }

  stopDevServer(): NextProductDevServerSnapshot {
    this.#listener?.close();
    this.#listener = null;
    this.#running = false;
    return this.#snapshot();
  }

  restart(): { restarted: boolean; previewAfterRestart: string } {
    this.stopDevServer();
    this.#restartCount += 1;
    this.startDevServer();
    this.#devServerCommand = this.#devServerCommand || "next dev";
    return {
      restarted: true,
      previewAfterRestart: this.preview("/").body
    };
  }

  preview(path = "/"): NextProductPreviewResult {
    if (!this.#running) return { statusCode: 503, body: "dev server unavailable" };
    const requestPath = normalizeRoutePath(path.split("?")[0] || "/");
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
      cliEntrypoint: null
    };
  }

  async fetch(input: string | URL): Promise<Response> {
    const response = await this.network.fetch(input);
    return new Response(response.body || "", {
      status: response.statusCode,
      ...(response.headers ? { headers: response.headers } : {})
    });
  }

  #snapshot(): NextProductDevServerSnapshot {
    return {
      port: this.#port,
      running: this.#running,
      restartCount: this.#restartCount,
      requests: [...this.#requests],
      command: this.#devServerCommand,
      source: "package-script",
      cliEntrypoint: null,
      processPid: this.#running ? this.#port : null,
      processStarted: this.#running,
      processExited: !this.#running,
      moduleTransform: "adapter"
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
    const globalsHref = this.workspace.exists(join(this.projectRoot, "app/globals.css"))
      ? '<link rel="stylesheet" href="./app/globals.css" />'
      : "";
    const importMap = JSON.stringify({
      imports: {
        react: "./node_modules/react/index.js",
        "react-dom": "./node_modules/react-dom/client.js",
        "react-dom/client": "./node_modules/react-dom/client.js",
        "react/jsx-runtime": "./node_modules/react/jsx-runtime.js",
        "react/jsx-dev-runtime": "./node_modules/react/jsx-runtime.js",
        next: "./node_modules/next/index.js",
        "next/link": "./node_modules/next/link.js",
        "next/navigation": "./node_modules/next/navigation.js",
        "next/image": "./node_modules/next/image.js"
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
      `<div id="app"><main><h1>${escapeHtml(title)}</h1><p>Next.js App Router</p></main></div>`,
      `<script>window.__NEXT_PREVIEW_ROUTE__=${JSON.stringify(routePath)};</script>`,
      "<script type=\"module\" src=\"./_next/static/chunks/app.js\"></script>",
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
      body: transformModule(layoutPath, this.workspace.readText(layoutPath))
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
      body: /\.(?:[cm]?tsx?|jsx)$/.test(transformPath) ? transformModule(transformPath, body) : body
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

  #installFixturePackage(pkg: string): void {
    const packageRoot = join(this.projectRoot, "node_modules", pkg);
    if (pkg === "next") {
      this.workspace.writeText(join(packageRoot, "package.json"), JSON.stringify({
        name: "next",
        version: "15.1.0",
        type: "module",
        exports: {
          ".": "./index.js",
          "./link": "./link.js",
          "./navigation": "./navigation.js",
          "./image": "./image.js"
        }
      }));
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

function createNextMounts(projectRoot: string, title: string) {
  return [
    {
      path: join(projectRoot, "package.json"),
      data: JSON.stringify({
        name: "next-app",
        private: true,
        version: "0.0.0",
        scripts: {
          dev: "next dev",
          build: "next build",
          start: "next start"
        },
        dependencies: {
          next: "15.1.0",
          react: "^19.0.0",
          "react-dom": "^19.0.0"
        },
        devDependencies: {
          "@types/node": "^22.0.0",
          "@types/react": "^19.0.0",
          "@types/react-dom": "^19.0.0",
          typescript: "^5.7.2"
        }
      }, null, 2) + "\n"
    },
    {
      path: join(projectRoot, "app/layout.tsx"),
      data: [
        "export const metadata = {",
        `  title: ${JSON.stringify(title)},`,
        "  description: \"Next.js App Router preview\",",
        "};",
        "",
        "export default function RootLayout({",
        "  children,",
        "}: Readonly<{ children: React.ReactNode }>) {",
        "  return (",
        "    <html lang=\"en\">",
        "      <body>{children}</body>",
        "    </html>",
        "  );",
        "}",
        ""
      ].join("\n")
    },
    {
      path: join(projectRoot, "app/page.tsx"),
      data: [
        "import Link from \"next/link\";",
        "",
        "export default function Page() {",
        "  return (",
        "    <main>",
        `      <h1>${title}</h1>`,
        "      <p>Edit <code>app/page.tsx</code> to get started.</p>",
        "      <p><Link href=\"/about\">About</Link></p>",
        "    </main>",
        "  );",
        "}",
        ""
      ].join("\n")
    },
    {
      path: join(projectRoot, "app/about/page.tsx"),
      data: [
        "import Link from \"next/link\";",
        "",
        "export default function AboutPage() {",
        "  return (",
        "    <main>",
        "      <h1>About</h1>",
        "      <p>Multi-route App Router preview.</p>",
        "      <p><Link href=\"/\">Home</Link></p>",
        "    </main>",
        "  );",
        "}",
        ""
      ].join("\n")
    },
    {
      path: join(projectRoot, "next-env.d.ts"),
      data: "/// <reference types=\"next\" />\n/// <reference types=\"next/image-types/global\" />\n"
    },
    {
      path: join(projectRoot, "tsconfig.json"),
      data: JSON.stringify({
        compilerOptions: {
          target: "ES2017",
          lib: ["dom", "dom.iterable", "esnext"],
          allowJs: true,
          skipLibCheck: true,
          strict: true,
          noEmit: true,
          esModuleInterop: true,
          module: "esnext",
          moduleResolution: "bundler",
          resolveJsonModule: true,
          isolatedModules: true,
          jsx: "preserve",
          incremental: true,
          plugins: [{ name: "next" }],
          paths: { "@/*": ["./*"] }
        },
        include: ["next-env.d.ts", "**/*.ts", "**/*.tsx"],
        exclude: ["node_modules"]
      }, null, 2) + "\n"
    }
  ];
}

function buildAppRouterBootstrap(): string {
  return [
    "import { createRoot } from \"react-dom/client\";",
    "import { jsx as __mountJsx } from \"react/jsx-runtime\";",
    "",
    "function currentRoute() {",
    "  if (typeof window !== \"undefined\" && window.__NEXT_PREVIEW_ROUTE__) return window.__NEXT_PREVIEW_ROUTE__;",
    "  const match = location.pathname.match(/\\/__preview\\/[^/]+\\/\\d+(\\/.*)?$/);",
    "  return match && match[1] ? match[1] : \"/\";",
    "}",
    "",
    "function pageModuleUrl(route) {",
    "  // app.js lives at /_next/static/chunks/app.js → go up to preview root.",
    "  if (!route || route === \"/\") return new URL(\"../../../app/page.js\", import.meta.url).href;",
    "  return new URL(`../../../app${route}/page.js`, import.meta.url).href;",
    "}",
    "",
    "async function mount() {",
    "  const route = currentRoute();",
    "  const pageMod = await import(pageModuleUrl(route));",
    "  let Layout = ({ children }) => children;",
    "  try {",
    "    const layoutMod = await import(new URL(\"../../../app/layout.js\", import.meta.url).href);",
    "    if (layoutMod?.default) Layout = layoutMod.default;",
    "  } catch {}",
    "  const Page = pageMod.default;",
    "  const target = document.getElementById(\"app\") || document.getElementById(\"root\");",
    "  if (!target || !Page) return;",
    "  const pageTree = __mountJsx(Page, {});",
    "  // Root layout often returns <html>/<body>; unwrap to children for iframe mount.",
    "  const wrapped = __mountJsx(Layout, { children: pageTree });",
    "  const view = (wrapped && wrapped.type === \"html\")",
    "    ? (wrapped.props?.children?.props?.children ?? wrapped.props?.children ?? pageTree)",
    "    : wrapped;",
    "  createRoot(target).render(view);",
    "}",
    "",
    "mount().catch((error) => {",
    "  const target = document.getElementById(\"app\") || document.getElementById(\"root\");",
    "  if (target) target.textContent = String(error && error.message || error);",
    "  console.error(error);",
    "});",
    ""
  ].join("\n");
}

function transformModule(path: string, source: string): string {
  const result = transpileTypeScript(source, {
    fileName: path,
    jsx: /\.(?:jsx|tsx)$/.test(path) ? "react-jsx" : "react"
  });
  return rewriteBrowserModuleImports(result.code);
}

function rewriteBrowserModuleImports(source: string): string {
  return source.replace(
    /from\s+["'](\.[^"']+)["']/g,
    (full, specifier: string) => {
      if (/\.[a-z0-9]+$/i.test(specifier)) return full;
      return full.replace(specifier, `${specifier}.js`);
    }
  );
}

function assertNextDevCommand(command: string): void {
  if (!/^next(\s|$)/.test(command) || command.includes(" build") || command.includes(" start")) {
    throw new Error(`unsupported Next.js dev command: ${command}`);
  }
}

function normalizeServedPath(path: string): string {
  const normalized = path.replaceAll("\\", "/").replace(/\/+/g, "/");
  return normalized.startsWith("/") ? normalized : `/${normalized}`;
}

function normalizeRoutePath(path: string): string {
  const normalized = normalizeServedPath(path);
  if (normalized.length > 1 && normalized.endsWith("/")) return normalized.slice(0, -1);
  return normalized || "/";
}

function contentTypeForPath(path: string): string {
  if (path.endsWith(".css")) return "text/css; charset=utf-8";
  if (path.endsWith(".html")) return "text/html; charset=utf-8";
  if (path.endsWith(".js") || path.endsWith(".jsx") || path.endsWith(".ts") || path.endsWith(".tsx") || path.endsWith(".mjs")) {
    return "text/javascript; charset=utf-8";
  }
  return "application/octet-stream";
}

function hmrLabelForSource(path: string, source: string): string {
  return source.match(/<h1[^>]*>([^<]+)<\/h1>/)?.[1]
    || path.split("/").filter(Boolean).at(-1)
    || path;
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("\"", "&quot;");
}

function toRuntimeHttpResponse(preview: NextProductPreviewResult): RuntimeHttpResponse {
  return {
    statusCode: preview.statusCode,
    headers: preview.headers || { "content-type": "text/html; charset=utf-8" },
    body: preview.body
  };
}

const REACT_SHIM = [
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
].join("\n");

const JSX_RUNTIME_SHIM = [
  "import { createElement, Fragment } from './index.js';",
  "export function jsx(type, props, key) {",
  "  const { children, ...rest } = props || {};",
  "  const next = key === undefined ? rest : { ...rest, key };",
  "  return createElement(type, next, ...(Array.isArray(children) ? children : children === undefined ? [] : [children]));",
  "}",
  "export const jsxs = jsx;",
  "export { Fragment };",
  ""
].join("\n");

const REACT_DOM_SHIM = [
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
  "  return { render(value) { element = value; mount(); } };",
  "}",
  ""
].join("\n");
