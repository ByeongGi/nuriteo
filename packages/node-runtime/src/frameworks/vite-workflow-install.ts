import { join } from "../builtins/path.ts";
import { ViteProductPackageArtifactError, decodeBase64, normalizePackageArtifactPath, readVitePackageBinPath } from "./vite-artifacts.ts";
import type { VitePackageManifest, ViteProductPackageArtifact } from "./vite-artifacts.ts";

import type { ViteProductWorkflow } from "./vite-workflow.ts";
import { shouldKeepInstalledPackage } from "./vite-workflow-preview.ts";
import type { ViteProductPackageSource } from "./vite-workflow-types.ts";
import { isPackageAliasName } from "./vite-workflow-run.ts";
import type { PackageManagerWorkspaceMount } from "../package-managers/workspace.ts";

export function installVitePackage(workflow: ViteProductWorkflow): void {
  if (workflow.vitePackageArtifact) {
    installVitePackageArtifact(workflow, workflow.vitePackageArtifact);
    return;
  }
  installViteCliEntrypoint(workflow);
}


export function installVitePackageArtifact(workflow: ViteProductWorkflow, artifact: ViteProductPackageArtifact): void {
  const packageRoot = join(workflow.projectRoot, "node_modules/vite");
  for (const mount of artifact.mounts) {
    writePackageMount(workflow, join(packageRoot, normalizePackageArtifactPath(mount.path)), mount);
  }
  const packageJsonPath = join(packageRoot, "package.json");
  if (!workflow.workspace.exists(packageJsonPath)) {
    throw new ViteProductPackageArtifactError("EVITEARTIFACTMANIFEST", "Mounted Vite package artifact must include package.json.", packageJsonPath);
  }
  const manifest = readVitePackageManifest(workflow);
  if (manifest.name !== "vite") {
    throw new ViteProductPackageArtifactError("EVITEARTIFACTNAME", "Mounted Vite package artifact package.json must have name \"vite\".", packageJsonPath);
  }
  const binPath = join(packageRoot, readVitePackageBinPath(manifest));
  if (!workflow.workspace.exists(binPath)) {
    throw new ViteProductPackageArtifactError("EVITEARTIFACTBIN", "Mounted Vite package artifact bin entry is missing.", binPath);
  }
  workflow.workspace.symlink(binPath, join(workflow.projectRoot, "node_modules/.bin/vite"));
}


export function installFixturePackage(workflow: ViteProductWorkflow, pkg: string): void {
  if (shouldKeepInstalledPackage(workflow.workspace, join(workflow.projectRoot, "node_modules", pkg, "package.json"))) return;
  const packageRoot = join(workflow.projectRoot, "node_modules", pkg);
  if (pkg === "react") {
    workflow.workspace.writeText(join(packageRoot, "package.json"), JSON.stringify({
      name: "react",
      nuriteoFixture: true,
      version: "18.3.1",
      type: "module",
      exports: {
        ".": "./index.js",
        "./jsx-runtime": "./jsx-runtime.js",
        "./jsx-dev-runtime": "./jsx-runtime.js"
      }
    }));
    workflow.workspace.writeText(join(packageRoot, "index.js"), [
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
    workflow.workspace.writeText(join(packageRoot, "jsx-runtime.js"), [
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
    workflow.workspace.writeText(join(packageRoot, "package.json"), JSON.stringify({
      name: "react-dom",
      nuriteoFixture: true,
      version: "18.3.1",
      type: "module",
      exports: {
        ".": "./client.js",
        "./client": "./client.js"
      }
    }));
    workflow.workspace.writeText(join(packageRoot, "client.js"), [
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
    workflow.workspace.writeText(join(packageRoot, "package.json"), JSON.stringify({
      name: pkg,
      nuriteoFixture: true,
      version: "latest",
      type: "module",
      exports: {
        ".": "./index.js"
      }
    }));
    workflow.workspace.writeText(join(packageRoot, "index.js"), "export default function react() { return { name: 'browser-native-react-plugin' }; }\n");
    return;
  }
  workflow.workspace.writeText(join(packageRoot, "package.json"), JSON.stringify({ name: pkg, version: "product-fixture" }));
}


export function installEsbuildShim(workflow: ViteProductWorkflow): void {
  if (workflow.workspace.exists(join(workflow.projectRoot, "node_modules/esbuild/package.json"))) return;
  const packageRoot = join(workflow.projectRoot, "node_modules/esbuild");
  workflow.workspace.writeText(join(packageRoot, "package.json"), JSON.stringify({
    name: "esbuild",
    version: "browser-native-shim",
    type: "module",
    exports: {
      ".": "./index.js"
    }
  }));
  workflow.workspace.writeText(join(packageRoot, "index.js"), [
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


export function installDependencyArtifacts(workflow: ViteProductWorkflow): void {
  for (const artifact of workflow.dependencyArtifacts) {
    const packageRoot = join(workflow.projectRoot, "node_modules", artifact.name);
    for (const mount of artifact.mounts) {
      writePackageMount(workflow, join(packageRoot, normalizePackageArtifactPath(mount.path)), mount);
    }
    const packageJsonPath = join(packageRoot, "package.json");
    if (!workflow.workspace.exists(packageJsonPath)) {
      throw new ViteProductPackageArtifactError("EVITEARTIFACTMANIFEST", `Mounted dependency artifact ${artifact.name} must include package.json.`, packageJsonPath);
    }
    const manifest = JSON.parse(workflow.workspace.readText(packageJsonPath)) as VitePackageManifest;
    if (manifest.name !== artifact.name && !isPackageAliasName(artifact.name, manifest.name)) {
      throw new ViteProductPackageArtifactError(
        "EVITEARTIFACTNAME",
        `Mounted dependency artifact package.json must have name "${artifact.name}".`,
        packageJsonPath
      );
    }
  }
}


export function hasDependencyArtifact(workflow: ViteProductWorkflow, name: string): boolean {
  return workflow.dependencyArtifacts.some((artifact) => artifact.name === name);
}


export function writePackageMount(workflow: ViteProductWorkflow, path: string, mount: PackageManagerWorkspaceMount): void {
  if (mount.encoding === "base64") {
    workflow.workspace.writeBytes(path, decodeBase64(mount.data));
    return;
  }
  workflow.workspace.writeText(path, mount.data);
}


export function installViteCliEntrypoint(workflow: ViteProductWorkflow): void {
  const packageJsonPath = join(workflow.projectRoot, "node_modules/vite/package.json");
  workflow.workspace.writeText(packageJsonPath, JSON.stringify({ name: "vite", version: "8.2.0", type: "module", bin: { vite: "bin/vite.js" } }));
  workflow.workspace.writeText(join(workflow.projectRoot, "node_modules/vite/bin/vite.js"), "#!/usr/bin/env node\nimport '../dist/node/cli.js';\n");
  workflow.workspace.writeText(
    join(workflow.projectRoot, "node_modules/vite/dist/node/cli.js"),
    "import { createRequire } from 'node:module';\nimport { runBuild } from './build.js';\nimport { startDevServer } from './server.js';\nconst require = createRequire(import.meta.url);\nrequire('../../package.json');\nif (process.argv.includes('build')) {\n  runBuild({ outDir: 'dist' });\n} else {\n  startDevServer({ host: '127.0.0.1', port: Number(process.env.PORT || 5173) });\n}\n"
  );
  workflow.workspace.writeText(
    join(workflow.projectRoot, "node_modules/vite/dist/node/build.js"),
    "export function runBuild(options) {\n  global.__viteRegisterBuild?.({ command: 'build', outDir: options.outDir, source: 'vite-cli' });\n}\n"
  );
  workflow.workspace.writeText(
    join(workflow.projectRoot, "node_modules/vite/dist/node/server.js"),
    "import { EventEmitter } from 'node:events';\nimport { createHotChannel } from './hmr.js';\nimport { registerTransform } from './transform.js';\nexport function startDevServer(options) {\n  const server = new EventEmitter();\n  registerTransform();\n  createHotChannel(server);\n  global.__viteRegisterDevServer?.({ command: 'dev', host: options.host, port: options.port, source: 'vite-cli' });\n  return server;\n}\n"
  );
  workflow.workspace.writeText(
    join(workflow.projectRoot, "node_modules/vite/dist/node/hmr.js"),
    "export function createHotChannel(server) {\n  server.emit('vite:hmr-ready');\n  const channel = { send(update) { global.__viteBroadcastHmr?.(update); return update; } };\n  global.__viteRegisterHmrChannel?.({ channel: 'hmr', source: 'vite-cli', transport: 'loopback', sendUpdate: channel.send });\n  return channel;\n}\n"
  );
  workflow.workspace.writeText(
    join(workflow.projectRoot, "node_modules/vite/dist/node/transform.js"),
    "export function registerTransform() {\n  global.__viteRegisterTransform?.({ mode: 'browser-esm', source: 'vite-cli', transformRequest(request) { return { code: `// transformed by vite-cli service:${request.path}\\n${request.source}` }; } });\n}\n"
  );
  workflow.workspace.symlink(join(workflow.projectRoot, "node_modules/vite/bin/vite.js"), join(workflow.projectRoot, "node_modules/.bin/vite"));
}


export function readVitePackageVersion(workflow: ViteProductWorkflow): string {
  const manifest = readVitePackageManifest(workflow);
  return manifest.version || workflow.vitePackageArtifact?.version || "8.2.0";
}


export function readVitePackageManifest(workflow: ViteProductWorkflow): VitePackageManifest {
  return JSON.parse(workflow.workspace.readText(join(workflow.projectRoot, "node_modules/vite/package.json"))) as VitePackageManifest;
}


export function vitePackageSource(workflow: ViteProductWorkflow): ViteProductPackageSource {
  return workflow.vitePackageArtifact ? "mounted-artifact" : "stub";
}


export function resolveCommandEntrypoint(workflow: ViteProductWorkflow, command: string): string {
  const [binary] = command.split(/\s+/);
  if (!binary) throw new Error(`missing command binary: ${command}`);
  return resolveBin(workflow, binary);
}


export function resolveBin(workflow: ViteProductWorkflow, binary: string): string {
  const binPath = join(workflow.projectRoot, "node_modules/.bin", binary);
  if (!workflow.workspace.exists(binPath)) throw new Error(`missing package bin: ${binary}`);
  return workflow.workspace.readlink(binPath);
}
