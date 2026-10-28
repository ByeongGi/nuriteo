import { join } from "../builtins/path.ts";

import { type RuntimeHttpResponse } from "../net/index.ts";


import { type PackageManagerWorkspaceMount } from "../package-managers/workspace.ts";
import { transpileTypeScript } from "../transforms/typescript.ts";

import type { WorkspaceModuleReader } from "../modules/index.ts";
import { finishPreviewModule } from "./vite-workflow.ts";
import type { NextPackageManifest, NextProductPackageArtifact, NextProductPackageArtifactFromWorkspaceOptions } from "./next-workflow.ts";
import type { NextProductDependencyArtifact, NextProductDependencyArtifactFromWorkspaceOptions, NextProductPreviewResult } from "./next-workflow.ts";

export function createNextPackageArtifactFromWorkspace(
  options: NextProductPackageArtifactFromWorkspaceOptions
): NextProductPackageArtifact {
  const packageRoot = normalizeServedPath(options.packageRoot).replace(/\/$/, "");
  const manifestPath = join(packageRoot, "package.json");
  const manifest = JSON.parse(options.reader.readText(manifestPath)) as NextPackageManifest;
  if (manifest.name !== "next") {
    throw new Error(`Next.js package artifact package.json must have name "next": ${manifestPath}`);
  }
  const binPath = join(packageRoot, readNextPackageBinPath(manifest));
  if (!workspaceReaderExists(options.reader, binPath)) {
    throw new Error(`Next.js package artifact bin entry is missing: ${binPath}`);
  }
  return {
    mounts: collectPackageMounts(options.reader, packageRoot),
    version: options.version || manifest.version || "unknown"
  };
}

export function createNextDependencyArtifactFromWorkspace(
  options: NextProductDependencyArtifactFromWorkspaceOptions
): NextProductDependencyArtifact {
  const packageRoot = normalizeServedPath(options.packageRoot).replace(/\/$/, "");
  const manifestPath = join(packageRoot, "package.json");
  const manifest = JSON.parse(options.reader.readText(manifestPath)) as NextPackageManifest;
  const name = options.name || manifest.name;
  if (!name || manifest.name !== name) {
    throw new Error(`Dependency artifact package.json must have name "${name || "<missing>"}": ${manifestPath}`);
  }
  return {
    mounts: collectPackageMounts(options.reader, packageRoot),
    name,
    ...((options.version || manifest.version) ? { version: options.version || manifest.version } : {})
  };
}

export function createNextMounts(projectRoot: string, title: string) {
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
          next: "15.5.26",
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

export function buildAppRouterBootstrap(): string {
  return [
    "import { createRoot } from \"react-dom/client\";",
    "import { jsx as __mountJsx } from \"react/jsx-runtime\";",
    "",
    "const hotUpdate = new URL(import.meta.url).searchParams.get(\"nuriteo_hmr\");",
    "",
    "function versionedModuleUrl(value) {",
    "  const url = new URL(value, import.meta.url);",
    "  if (hotUpdate) url.searchParams.set(\"nuriteo_hmr\", hotUpdate);",
    "  return url.href;",
    "}",
    "",
    "function currentRoute() {",
    "  if (typeof window !== \"undefined\" && window.__NEXT_PREVIEW_ROUTE__) return window.__NEXT_PREVIEW_ROUTE__;",
    "  const match = location.pathname.match(/\\/__preview\\/[^/]+\\/\\d+(\\/.*)?$/);",
    "  return match && match[1] ? match[1] : \"/\";",
    "}",
    "",
    "function pageModuleUrl(route) {",
    "  if (typeof window !== \"undefined\" && window.__NEXT_PREVIEW_PAGE_MODULE__) {",
    "    return versionedModuleUrl(window.__NEXT_PREVIEW_PAGE_MODULE__);",
    "  }",
    "  if (!route || route === \"/\") return versionedModuleUrl(\"/app/page.js\");",
    "  return versionedModuleUrl(`/app${route}/page.js`);",
    "}",
    "",
    "async function mount() {",
    "  const route = currentRoute();",
    "  const pageMod = await import(pageModuleUrl(route));",
    "  let Layout = ({ children }) => children;",
    "  try {",
    "    const layoutMod = await import(versionedModuleUrl(\"../../../app/layout.js\"));",
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
    "  const root = globalThis.__NURITEO_NEXT_PREVIEW_ROOT__ ||= createRoot(target);",
    "  root.render(view);",
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

export function transformModule(
  path: string,
  source: string,
  resolveSpecifier?: (specifier: string) => string | undefined,
  context?: Parameters<typeof finishPreviewModule>[3]
): string {
  const result = transpileTypeScript(source, {
    fileName: path,
    jsx: /\.(?:jsx|tsx)$/.test(path) ? "react-jsx" : "react"
  });
  return finishPreviewModule(path, result.code, resolveSpecifier, context);
}

export function transformServedModule(
  path: string,
  source: string,
  resolveSpecifier?: (specifier: string) => string | undefined,
  context?: Parameters<typeof finishPreviewModule>[3]
): string {
  if (!/\.(?:[cm]?jsx?|tsx?)$/.test(path)) return source;
  if (/\.(?:[cm]?tsx?|jsx)$/.test(path)) return transformModule(path, source, resolveSpecifier, context);
  return finishPreviewModule(path, source, resolveSpecifier, context);
}

export function assertNextDevCommand(command: string): void {
  if (!/^next(\s|$)/.test(command) || command.includes(" build") || command.includes(" start")) {
    throw new Error(`unsupported Next.js dev command: ${command}`);
  }
}

export function assertNextBuildCommand(command: string): void {
  if (command !== "next build") throw new Error(`unsupported Next.js build command: ${command}`);
}

export function assertNextStartCommand(command: string): void {
  if (!/^next\s+start(?:\s|$)/.test(command)) {
    throw new Error(`unsupported Next.js start command: ${command}`);
  }
}

export function commandArgs(command: string): string[] {
  return command.split(/\s+/).slice(1).filter(Boolean);
}

export function readNextPackageBinPath(manifest: NextPackageManifest): string {
  if (typeof manifest.bin === "string") return manifest.bin;
  return manifest.bin?.next || "dist/bin/next";
}

export function normalizePackageArtifactPath(path: string): string {
  return path.replace(/^\/+/, "");
}

export function collectPackageMounts(reader: WorkspaceModuleReader, packageRoot: string): PackageManagerWorkspaceMount[] {
  const mounts: PackageManagerWorkspaceMount[] = [];
  for (const file of walkWorkspaceFiles(reader, packageRoot)) {
    const path = file.slice(packageRoot.length + 1);
    if (path.endsWith(".map")) continue;
    if (isBinaryPackageMount(path)) {
      mounts.push({ path, data: encodeBase64(readWorkspaceBytes(reader, file)), encoding: "base64" });
    } else {
      mounts.push({ path, data: reader.readText(file) });
    }
  }
  return mounts.sort((left, right) => left.path.localeCompare(right.path));
}

function* walkWorkspaceFiles(reader: WorkspaceModuleReader, path: string): Generator<string> {
  try {
    for (const entry of reader.listDir(path)) {
      yield* walkWorkspaceFiles(reader, join(path, entry));
    }
  } catch {
    yield path;
  }
}

export function workspaceReaderExists(reader: WorkspaceModuleReader, path: string): boolean {
  const candidate = reader as WorkspaceModuleReader & { exists?: (path: string) => boolean };
  if (candidate.exists?.(path) === true) return true;
  try {
    reader.readText(path);
    return true;
  } catch {
    return false;
  }
}

export function isBinaryPackageMount(path: string): boolean {
  return /\.(?:wasm|node|png|jpe?g|gif|ico|woff2?|ttf)$/i.test(path);
}

export function readWorkspaceBytes(reader: WorkspaceModuleReader, path: string): Uint8Array {
  const candidate = reader as WorkspaceModuleReader & { readBytes?: (path: string) => Uint8Array };
  return candidate.readBytes?.(path) || new TextEncoder().encode(reader.readText(path));
}

export function encodeBase64(bytes: Uint8Array): string {
  const bufferCtor = (globalThis as typeof globalThis & {
    Buffer?: { from(value: Uint8Array): { toString(encoding: "base64"): string } };
  }).Buffer;
  if (bufferCtor) return bufferCtor.from(bytes).toString("base64");
  if (typeof btoa === "function") {
    const encoded: string[] = [];
    const chunkSize = 24_576;
    for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
      const chunk = bytes.subarray(offset, offset + chunkSize);
      encoded.push(btoa(String.fromCharCode(...chunk)));
    }
    return encoded.join("");
  }
  throw new Error("Base64 encoding is not available in this runtime");
}

export function decodeBase64(value: string): Uint8Array {
  const bufferCtor = (globalThis as typeof globalThis & {
    Buffer?: { from(value: string, encoding: "base64"): Uint8Array };
  }).Buffer;
  if (bufferCtor) return new Uint8Array(bufferCtor.from(value, "base64"));
  if (typeof atob === "function") {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  }
  throw new Error("Base64 decoding is not available in this runtime");
}

export function normalizeServedPath(path: string): string {
  const normalized = path.replaceAll("\\", "/").replace(/\/+/g, "/");
  return normalized.startsWith("/") ? normalized : `/${normalized}`;
}

export function normalizeRoutePath(path: string): string {
  const normalized = normalizeServedPath(path);
  if (normalized.length > 1 && normalized.endsWith("/")) return normalized.slice(0, -1);
  return normalized || "/";
}

export function contentTypeForPath(path: string): string {
  const pathname = path.split(/[?#]/u, 1)[0] ?? path;
  if (pathname.endsWith(".css")) return "text/css; charset=utf-8";
  if (pathname.endsWith(".html")) return "text/html; charset=utf-8";
  if (/\.(?:[cm]?[jt]sx?)$/iu.test(pathname)) return "text/javascript; charset=utf-8";
  return "application/octet-stream";
}

export function hmrLabelForSource(path: string, source: string): string {
  return source.match(/<h1[^>]*>([^<]+)<\/h1>/)?.[1]
    || path.split("/").filter(Boolean).at(-1)
    || path;
}

export function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("\"", "&quot;");
}

export function toRuntimeHttpResponse(preview: NextProductPreviewResult): RuntimeHttpResponse {
  return {
    statusCode: preview.statusCode,
    headers: preview.headers || { "content-type": "text/html; charset=utf-8" },
    body: preview.body
  };
}

export function toResponseBody(body: RuntimeHttpResponse["body"]): BodyInit {
  if (!(body instanceof Uint8Array)) return body || "";
  const copy = new Uint8Array(body.byteLength);
  copy.set(body);
  return copy.buffer;
}

export const REACT_SHIM = [
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

export const JSX_RUNTIME_SHIM = [
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

export const REACT_DOM_SHIM = [
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
