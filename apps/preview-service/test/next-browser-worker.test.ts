import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import path, { dirname } from "node:path";

import { chromium } from "@playwright/test";
import { createServer } from "../node_modules/vite/dist/node/index.js";

import { REQUIRED_RUNTIME_HEADERS } from "../../../packages/browser-host/src/security/headers.ts";
import {
  createNextDependencyArtifactFromWorkspace,
  createNextPackageArtifactFromWorkspace,
  NextProductWorkflow
} from "../../../packages/node-runtime/src/frameworks/next-workflow.ts";
import { createNodeFsWorkspaceReader } from "../../../tooling/shared/fs-workspace-reader.ts";
import { analyzeCliModuleGraph } from "../../../packages/node-runtime/src/package-managers/cli-module-graph.ts";
import { createWorkspaceModuleRuntime } from "../../../packages/node-runtime/src/modules/index.ts";

const require = createRequire(import.meta.url);
const root = path.resolve(new URL("../../..", import.meta.url).pathname);
const nextRoot = dirname(realpathSync(require.resolve("next/package.json")));
const nextManifest = JSON.parse(fs.readFileSync(path.join(nextRoot, "package.json"), "utf8"));
const nextEntry = fs.readFileSync(path.join(nextRoot, "dist/bin/next"));
const nextEntrySha256 = createHash("sha256").update(nextEntry).digest("hex");
const chromePath = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

assert.equal(nextManifest.version, "15.5.26");
assert.equal(typeof nextManifest.bin === "string" ? nextManifest.bin : nextManifest.bin?.next, "./dist/bin/next");
assert.ok(fs.existsSync(chromePath), `Chrome not found at ${chromePath}`);

const requireFromNext = createRequire(`${nextRoot}/package.json`);
const packageRoot = (name: string) => {
  try { return dirname(realpathSync(requireFromNext.resolve(`${name}/package.json`))); } catch {
    try { return dirname(realpathSync(require.resolve(`${name}/package.json`))); } catch {
      return dirname(realpathSync(require.resolve(name)));
    }
  }
};
const dependencyNames = [
  "@next/env", "@next/swc-wasm-nodejs", "@swc/helpers", "caniuse-lite", "client-only", "nanoid",
  "picocolors", "postcss", "react", "react-dom", "scheduler", "source-map-js", "styled-jsx", "typescript"
];
const nextPackageArtifact = createNextPackageArtifactFromWorkspace({
  packageRoot: "/vendor/next",
  reader: createNodeFsWorkspaceReader({ root: nextRoot, virtualRoot: "/vendor/next" })
});
const dependencyArtifacts = dependencyNames.map((name) => createNextDependencyArtifactFromWorkspace({
  name,
  packageRoot: "/vendor/dependency",
  reader: createNodeFsWorkspaceReader({ root: packageRoot(name), virtualRoot: "/vendor/dependency" })
}));
const workflow = new NextProductWorkflow({ dependencyArtifacts, manager: "pnpm", nextPackageArtifact, port: 3045 });
workflow.install();
workflow.workspace.writeText("/workspace/app/app/layout.js", "export default function RootLayout({ children }) { return <html><body>{children}</body></html> }");
workflow.workspace.writeText("/workspace/app/app/page.js", "export default function Page() { return <main><h1>Strict CSP Next Runtime</h1><p>{process.env.NURITEO_PLUGIN_PROOF}</p></main> }");
workflow.workspace.writeText("/workspace/app/next.config.js", "module.exports = { poweredByHeader: false, webpack(config, { webpack }) { config.plugins.push(new webpack.DefinePlugin({ 'process.env.NURITEO_PLUGIN_PROOF': JSON.stringify('config-plugin-ran') })); return config; } };");
workflow.workspace.writeText("/workspace/app/middleware.js", "import { NextResponse } from 'next/server'; export function middleware(request) { const response = NextResponse.next(); response.headers.set('x-nuriteo-middleware', request.nextUrl.pathname); return response; } export const config = { matcher: ['/about'] };");
workflow.workspace.writeText("/workspace/app/app/about/page.js", "export default function AboutPage() { return <main><h1>About Runtime</h1></main> }");
workflow.workspace.writeText("/workspace/app/app/action/page.js", "import { redirect } from 'next/navigation'; export default function ActionPage() { async function submit() { 'use server'; redirect('/action?message=hello'); } return <form action={submit}><button type='submit'>Send</button></form>; }");
workflow.workspace.writeText("/workspace/app/app/api/edge/route.js", "export const runtime = 'edge'; export async function GET() { return Response.json({ runtime: 'edge', ok: true }); }");
workflow.workspace.writeText("/workspace/app/app/isr/page.js", "export const revalidate = 1; export default function IsrPage() { return <main><h1>ISR Page</h1><time>{Date.now()}</time></main>; }");
workflow.workspace.writeText("/workspace/app/app/image/page.js", "import Image from 'next/image'; export default function ImagePage() { return <main><Image src='/pixel.png' width={1} height={1} alt='pixel' /></main>; }");
workflow.workspace.writeText("/workspace/app/pages/legacy.js", "export default function LegacyPage() { return <main><h1>Pages Router Runtime</h1></main>; }");
workflow.workspace.writeBytes("/workspace/app/public/pixel.png", Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64")));
workflow.workspace.remove("/workspace/app/app/layout.tsx");
workflow.workspace.remove("/workspace/app/app/page.tsx");
workflow.workspace.remove("/workspace/app/app/about/page.tsx");
workflow.workspace.remove("/workspace/app/tsconfig.json");
const cliGraph = analyzeCliModuleGraph({
  entry: "/workspace/app/node_modules/next/dist/bin/next",
  packageRoot: "/workspace/app/node_modules/next",
  reader: workflow.workspace,
  maxModules: 16_384
});
const graphPaths = new Set(cliGraph.modules.map((module) => module.path));
const graphRuntime = createWorkspaceModuleRuntime({ reader: workflow.workspace, root: "/workspace" });
for (const file of workflow.workspace.snapshot().files) {
  if (file.path.startsWith("/workspace/app/node_modules/next/dist/build/webpack/loaders/") && file.path.endsWith(".js")) graphPaths.add(file.path);
}
const pendingResolvedModules = [...graphPaths];
for (let index = 0; index < pendingResolvedModules.length; index += 1) {
  const importer = pendingResolvedModules[index];
  const definition = graphRuntime.getDefinition(importer);
  if (!definition || (definition.kind !== "cjs-source" && definition.kind !== "esm-source")) continue;
  const source = workflow.workspace.readText(importer);
  for (const match of source.matchAll(/\brequire(?:\.resolve)?\(\s*(['"`])([^'"`$]+)\1/g)) {
    try {
      const resolved = graphRuntime.resolve(match[2], importer);
      if (!graphPaths.has(resolved)) {
        graphPaths.add(resolved);
        pendingResolvedModules.push(resolved);
      }
    } catch {}
  }
}
const fullSnapshot = workflow.workspace.snapshot();
assert.ok(fullSnapshot.files.some((file) => file.path === "/workspace/app/node_modules/react/jsx-runtime.js"), "React JSX runtime missing from installed workspace");
assert.ok(fullSnapshot.files.some((file) => file.path === "/workspace/app/node_modules/next/dist/client/app-next-dev.js"), "Next app dev client missing from installed workspace");
const workspaceSnapshot = {
  directories: fullSnapshot.directories,
  files: fullSnapshot.files.filter((file) =>
    graphPaths.has(file.path)
    || file.path.startsWith("/workspace/app/node_modules/next/")
    || file.path.endsWith(".json")
    || file.path === "/workspace/app/node_modules/styled-jsx/style.js"
    || file.path.startsWith("/workspace/app/node_modules/next/dist/compiled/acorn/")
    || file.path.startsWith("/workspace/app/node_modules/next/dist/compiled/loader-runner/")
    || file.path.startsWith("/workspace/app/node_modules/next/dist/compiled/neo-async/")
    || file.path.startsWith("/workspace/app/node_modules/next/dist/compiled/webpack/")
    || file.path.startsWith("/workspace/app/node_modules/next/dist/compiled/regenerator-runtime/")
    || file.path.startsWith("/workspace/app/node_modules/next/dist/compiled/@next/react-refresh-utils/")
    || file.path.startsWith("/workspace/app/node_modules/next/dist/compiled/react-refresh/")
    || file.path.startsWith("/workspace/app/node_modules/next/dist/compiled/react/")
    || file.path.startsWith("/workspace/app/node_modules/next/dist/compiled/react-dom/")
    || file.path.startsWith("/workspace/app/node_modules/next/dist/compiled/react-server-dom-webpack/")
    || file.path.startsWith("/workspace/app/node_modules/next/dist/compiled/scheduler/")
    || file.path.startsWith("/workspace/app/node_modules/next/dist/compiled/server-only/")
    || file.path.startsWith("/workspace/app/node_modules/next/dist/compiled/client-only/")
    || file.path.startsWith("/workspace/app/node_modules/next/dist/build/webpack/loaders/")
    || file.path.startsWith("/workspace/app/node_modules/next/dist/build/polyfills/")
    || file.path.startsWith("/workspace/app/node_modules/next/dist/build/templates/")
    || file.path.startsWith("/workspace/app/node_modules/next/dist/esm/")
    || file.path.startsWith("/workspace/app/node_modules/next/dist/client/")
    || file.path.startsWith("/workspace/app/node_modules/next/dist/next-devtools/")
    || file.path.startsWith("/workspace/app/node_modules/next/dist/lib/")
    || file.path.startsWith("/workspace/app/node_modules/next/dist/pages/")
    || file.path.startsWith("/workspace/app/node_modules/next/dist/server/")
    || file.path.startsWith("/workspace/app/node_modules/react/")
    || file.path.startsWith("/workspace/app/node_modules/react-dom/")
    || file.path.startsWith("/workspace/app/node_modules/scheduler/")
    || file.path.startsWith("/workspace/app/node_modules/caniuse-lite/")
    || file.path.startsWith("/workspace/app/node_modules/@next/swc-wasm-nodejs/")
    || (file.path.startsWith("/workspace/app/node_modules/next/") && !file.path.slice("/workspace/app/node_modules/next/".length).includes("/"))
    || !file.path.startsWith("/workspace/app/node_modules/")),
  links: fullSnapshot.links
};
for (const requiredPath of [
  "/workspace/app/node_modules/next/dist/server/route-kind.js",
  "/workspace/app/node_modules/next/dist/server/lib/patch-fetch.js"
]) {
  assert.ok(workspaceSnapshot.files.some((file) => file.path === requiredPath), `filtered Next fixture is missing ${requiredPath}`);
}
let tamperFactoryResponse = false;

const server = await createServer({
  root,
  publicDir: path.join(root, "apps/preview-service/public"),
  configFile: false,
  server: { host: "127.0.0.1", port: 0 },
  plugins: [{
    name: "next-browser-worker-security-headers",
    configureServer(vite) {
      vite.middlewares.use((request, response, next) => {
        response.setHeader("Cross-Origin-Opener-Policy", REQUIRED_RUNTIME_HEADERS.coop);
        response.setHeader("Cross-Origin-Embedder-Policy", REQUIRED_RUNTIME_HEADERS.coep);
        response.setHeader("Content-Security-Policy", REQUIRED_RUNTIME_HEADERS.csp);
        if (request.url === "/vendor/next-cli-15.5.26.mjs" && tamperFactoryResponse) {
          response.setHeader("Content-Type", "text/javascript; charset=utf-8");
          response.end("export const sourceSha256 = 'tampered'; export function evaluateNextCjs() {}\n");
          return;
        }
        if (request.url === "/next-workspace-snapshot.json") {
          response.setHeader("Content-Type", "application/json; charset=utf-8");
          response.end(JSON.stringify(workspaceSnapshot));
          return;
        }
        if (request.url === "/next-browser-worker-probe") {
          response.setHeader("Content-Type", "text/html; charset=utf-8");
          response.end("<!doctype html><html><body>Next browser worker probe</body></html>");
          return;
        }
        next();
      });
    }
  }]
});

await server.listen();
const browser = await chromium.launch({
  args: ["--js-flags=--max-old-space-size=4096"],
  headless: true,
  executablePath: chromePath
});
try {
  const page = await browser.newPage();
  const response = await page.goto(`${server.resolvedUrls.local[0]}next-browser-worker-probe`, { waitUntil: "load" });
  assert.equal(response?.headers()["content-security-policy"], REQUIRED_RUNTIME_HEADERS.csp);
  assert.equal(await page.evaluate(() => crossOriginIsolated), true);
  await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.register("/preview-sw.js", { scope: "/" });
    await navigator.serviceWorker.ready;
    if (navigator.serviceWorker.controller) return;
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(resolve, 3000);
      navigator.serviceWorker.addEventListener("controllerchange", () => {
        clearTimeout(timeout);
        resolve();
      }, { once: true });
      void registration.update();
    });
  });
  assert.equal(await page.evaluate(() => Boolean(navigator.serviceWorker.controller)), true, "preview service worker did not claim the page");
  const workerModuleProbe = await page.evaluate(async () => {
    const response = await fetch("/workers/process-worker.ts", { cache: "no-store" });
    return { body: (await response.text()).slice(0, 200), status: response.status };
  });
  assert.equal(workerModuleProbe.status, 200, `process worker module preflight failed: ${workerModuleProbe.body}`);

  const cdp = await browser.newBrowserCDPSession();
  const pageCdp = await page.context().newCDPSession(page);
  await pageCdp.send("HeapProfiler.collectGarbage");
  const baselineHeapBytes = (await pageCdp.send("Runtime.getHeapUsage")).usedSize;
  const workerTargetCount = async () => {
    const targets = (await cdp.send("Target.getTargets")).targetInfos;
    return targets.filter((target) => target.type === "worker" && target.url.includes("/workers/process-worker.ts")).length;
  };
  const baselineTargets = await workerTargetCount();
  const assertWorkersReleased = async (label: string) => {
    let remainingTargets = await workerTargetCount();
    for (let attempt = 0; remainingTargets > baselineTargets && attempt < 30; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      remainingTargets = await workerTargetCount();
    }
    assert.equal(remainingTargets, baselineTargets, `Chrome retained a Next preflight worker after ${label}`);
  };

  const runPreflight = (id: number, command: "dev" | "build" | "start") => page.evaluate(async ({ command, entrySha256, id }) => {
    const snapshot = await fetch("/next-workspace-snapshot.json", { cache: "no-store" }).then((response) => response.json());
    const worker = new Worker("/workers/process-worker.ts", { type: "module" });
    try {
      return await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`Next ${command} worker preflight timed out`)), 60_000);
        let cliResult;
        let httpError;
        let httpResponse;
        let fsDiagnostic;
        let fsError;
        let hmrAttempt = 0;
        worker.addEventListener("message", (event) => {
          if (event.data?.type === "cli:fs:write:result" && event.data.evaluationId === id && event.data.id === 20_000 + id) {
            fsDiagnostic = event.data.result;
            fsError = event.data.error;
            worker.postMessage({
              evaluationId: id,
              id: 30_000 + id,
              port: cliResult.result.bridgedServerPorts[0],
              request: { method: "GET", path: "/", headers: { host: `localhost:${cliResult.result.bridgedServerPorts[0]}` } },
              type: "cli:http:request"
            });
            return;
          }
          if (event.data?.type === "cli:http:response" && event.data.evaluationId === id && event.data.id === 30_000 + id) {
            const body = event.data.response?.body;
            const text = typeof body === "string" ? body : body ? new TextDecoder().decode(body) : "";
            if (!text.includes("Strict CSP Next Runtime HMR") && hmrAttempt++ < 10) {
              setTimeout(() => worker.postMessage({
                evaluationId: id,
                id: 30_000 + id,
                port: cliResult.result.bridgedServerPorts[0],
                request: { method: "GET", path: `/?hmr=${hmrAttempt}`, headers: { host: `localhost:${cliResult.result.bridgedServerPorts[0]}`, "cache-control": "no-cache" } },
                type: "cli:http:request"
              }), 500);
              return;
            }
            clearTimeout(timeout);
            resolve({ ...cliResult, fsDiagnostic, fsError, httpError, httpResponse,
              hmrError: event.data.error, hmrResponse: event.data.response });
            return;
          }
          if (event.data?.type === "cli:http:response" && event.data.evaluationId === id && event.data.id === 10_000 + id) {
            httpError = event.data.error;
            httpResponse = event.data.response;
            worker.postMessage({
              data: "export default function Page() { return <main><h1>Strict CSP Next Runtime HMR</h1></main> }",
              evaluationId: id,
              id: 20_000 + id,
              path: "/workspace/app/app/page.js",
              type: "cli:fs:write"
            });
            return;
          }
          if (event.data?.type !== "cli:result" || event.data.id !== id) return;
          cliResult = event.data;
          if (command !== "dev" && event.data.result?.workspaceSnapshot) {
            event.data.result.workspaceFileCount = event.data.result.workspaceSnapshot.files.length;
            delete event.data.result.workspaceSnapshot;
          }
          const port = event.data.result?.bridgedServerPorts?.[0];
          if (command === "dev" && port) {
            worker.postMessage({
              evaluationId: id,
              id: 10_000 + id,
              port,
              request: { method: "GET", path: "/", headers: { host: `localhost:${port}` } },
              type: "cli:http:request"
            });
            return;
          }
          clearTimeout(timeout);
          resolve(event.data);
        });
        worker.addEventListener("error", async (event) => {
          clearTimeout(timeout);
          const probe = await fetch("/workers/process-worker.ts", { cache: "no-store" }).catch(() => null);
          reject(new Error(event.message || `process worker module load failed${probe ? ` status=${probe.status}` : ""}`));
        });
        worker.postMessage({
          bridgeLoopbackServer: true,
          id,
          type: "cli:evaluate",
          root: "/workspace",
          settleTicks: 12,
          settleTimeoutMs: 3000,
          request: {
            entry: {
              name: "next",
              version: "15.5.26",
              entry: "/workspace/app/node_modules/next/dist/bin/next",
              entrySha256,
              mode: "cjs"
            },
            args: [command],
            cwd: "/workspace/app",
            env: { PORT: "3045" }
          },
          workspaceSnapshot: snapshot
        });
      });
    } finally {
      worker.terminate();
    }
  }, { command, entrySha256: nextEntrySha256, id });

  for (const [index, command] of (["dev"] as const).entries()) {
    const outcome = await runPreflight(index + 1, command) as {
      error?: string;
      result?: { entrySha256?: string; exitCode?: number; stderr?: string };
    };
    assert.equal(outcome.error, undefined, `${command} worker transport failed: ${outcome.error}`);
    assert.equal(outcome.result?.entrySha256, nextEntrySha256);
    assert.equal(outcome.result?.exitCode, 0, outcome.result?.stderr);
    assert.equal((outcome as { httpResponse?: { statusCode?: number } }).httpResponse?.statusCode, 200);
    assert.equal((outcome as { hmrResponse?: { statusCode?: number } }).hmrResponse?.statusCode, 200);
    const hmrBody = (outcome as { hmrResponse?: { body?: string | Uint8Array } }).hmrResponse?.body;
    const liveOutput = (outcome as { fsDiagnostic?: { output?: { stderr?: string; stdout?: string } } }).fsDiagnostic?.output;
    assert.match(typeof hmrBody === "string" ? hmrBody : new TextDecoder().decode(hmrBody), /Strict CSP Next Runtime HMR/, JSON.stringify({ fs: (outcome as { fsDiagnostic?: unknown }).fsDiagnostic, liveOutput }));
    const diagnostics = liveOutput?.stderr?.split(" ⨯ ").slice(1).map((block) => block.split("\n").slice(0, 5).join("\n")).slice(0, 10);
    console.log(command, JSON.stringify({
      diagnostics,
      httpError: (outcome as { httpError?: string }).httpError,
      httpStatus: (outcome as { httpResponse?: { statusCode?: number } }).httpResponse?.statusCode,
      hmrStatus: (outcome as { hmrResponse?: { statusCode?: number } }).hmrResponse?.statusCode,
      ports: (outcome.result as { bridgedServerPorts?: number[] })?.bridgedServerPorts,
      stdout: liveOutput?.stdout
    }));
  }

  const productionLifecycle = await page.evaluate(async ({ entrySha256 }) => {
    const initialSnapshot = await fetch("/next-workspace-snapshot.json", { cache: "no-store" }).then((response) => response.json());
    const evaluate = (id: number, command: "build" | "start", snapshot: unknown) => {
      const worker = new Worker("/workers/process-worker.ts", { type: "module" });
      const completion = new Promise<any>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`Next ${command} lifecycle worker timed out`)), 120_000);
        worker.addEventListener("message", (event) => {
          if (event.data?.type !== "cli:result" || event.data.id !== id) return;
          if (event.data.error || command === "build") {
            clearTimeout(timeout);
            resolve(event.data);
            return;
          }
          const port = event.data.result?.bridgedServerPorts?.[0];
          if (!port) {
            clearTimeout(timeout);
            resolve(event.data);
            return;
          }
          let requestSequence = 0;
          const request = (requestInit: Record<string, unknown>) => new Promise<any>((resolveRequest) => {
            const requestId = id * 1000 + requestSequence++;
            const onHttp = (httpEvent: MessageEvent) => {
              if (httpEvent.data?.type !== "cli:http:response" || httpEvent.data.evaluationId !== id || httpEvent.data.id !== requestId) return;
              worker.removeEventListener("message", onHttp);
              resolveRequest(httpEvent.data);
            };
            worker.addEventListener("message", onHttp);
            worker.postMessage({
              evaluationId: id,
              id: requestId,
              port,
              request: { headers: { host: `localhost:${port}` }, method: "GET", ...requestInit },
              type: "cli:http:request"
            });
          });
          void (async () => {
            const responses: Record<string, any> = { root: await request({ path: "/" }) };
            if (id === 101) {
              responses.about = await request({ path: "/about" });
              responses.legacy = await request({ path: "/legacy" });
              responses.edge = await request({ path: "/api/edge" });
              responses.actionPage = await request({ path: "/action" });
              const actionBody = responses.actionPage.response?.body;
              const actionHtml = typeof actionBody === "string" ? actionBody : actionBody ? new TextDecoder().decode(actionBody) : "";
              const actionId = /name="\$ACTION_ID_([^"]+)"/.exec(actionHtml)?.[1];
              responses.actionId = actionId;
              if (actionId) {
                responses.action = await request({
                  body: "[]",
                  headers: {
                    accept: "text/x-component",
                    "content-type": "text/plain;charset=UTF-8",
                    host: `localhost:${port}`,
                    "next-action": actionId
                  },
                  method: "POST",
                  path: "/action"
                });
              }
              responses.isrInitial = await request({ path: "/isr" });
              await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
              responses.isrFresh = await request({ path: "/isr" });
              await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_100));
              responses.isrStale = await request({ path: "/isr" });
              await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
              responses.isrRegenerated = await request({ path: "/isr" });
              responses.image = await request({ path: "/_next/image?url=%2Fpixel.png&w=16&q=75" });
            }
            clearTimeout(timeout);
            resolve({ ...event.data, responses });
          })().catch((error) => {
            clearTimeout(timeout);
            reject(error);
          });
        });
        worker.addEventListener("error", (event) => {
          clearTimeout(timeout);
          reject(new Error(`${event.message || `Next ${command} lifecycle worker failed`}\n${event.error?.stack || ""}\n${event.filename || ""}:${event.lineno || 0}:${event.colno || 0}`));
        });
        worker.postMessage({
          bridgeLoopbackServer: true,
          id,
          type: "cli:evaluate",
          root: "/workspace",
          settleTicks: 12,
          settleTimeoutMs: 3000,
          request: {
            entry: {
              name: "next",
              version: "15.5.26",
              entry: "/workspace/app/node_modules/next/dist/bin/next",
              entrySha256,
              mode: "cjs"
            },
            args: [command],
            cwd: "/workspace/app",
            env: { PORT: "3045" }
          },
          workspaceSnapshot: snapshot
        });
      });
      return { completion, worker };
    };

    const buildRun = evaluate(100, "build", initialSnapshot);
    const build = await buildRun.completion;
    buildRun.worker.terminate();
    const builtSnapshot = build.result?.workspaceSnapshot;
    if (!builtSnapshot) {
      return { build: { error: build.error, result: build.result } };
    }
    const buildSummary = {
      entrySha256: build.result.entrySha256,
      exitCode: build.result.exitCode,
      stderr: build.result.stderr,
      stdout: build.result.stdout,
      files: builtSnapshot.files
        .filter((file: { path: string }) => file.path.startsWith("/workspace/app/.next/"))
        .map((file: { path: string }) => file.path.slice("/workspace/app/".length))
    };
    const startOnce = async (id: number) => {
      const run = evaluate(id, "start", builtSnapshot);
      try {
        const result = await run.completion;
        const summarizeResponse = (message: any) => {
          const body = message?.response?.body;
          return {
            body: typeof body === "string" ? body : body ? new TextDecoder().decode(body) : "",
            bytes: body instanceof Uint8Array ? [...body.slice(0, 4)] : [],
            error: message?.error,
            headers: message?.response?.headers,
            output: message?.output,
            status: message?.response?.statusCode
          };
        };
        return {
          entrySha256: result.result?.entrySha256,
          error: result.error,
          exitCode: result.result?.exitCode,
          ports: result.result?.bridgedServerPorts,
          responses: Object.fromEntries(Object.entries(result.responses || {}).map(([key, value]) => [key, key === "actionId" ? value : summarizeResponse(value)])),
          stderr: result.result?.stderr,
          stdout: result.result?.stdout
        };
      } finally {
        run.worker.terminate();
      }
    };
    return {
      build: buildSummary,
      firstStart: await startOnce(101),
      restarted: await startOnce(102)
    };
  }, { entrySha256: nextEntrySha256 }) as {
    build: { entrySha256?: string; error?: string; exitCode?: number; files?: string[]; stderr?: string; stdout?: string };
    firstStart?: { entrySha256?: string; error?: string; exitCode?: number; responses?: Record<string, any>; stderr?: string };
    restarted?: { entrySha256?: string; error?: string; exitCode?: number; responses?: Record<string, any>; stderr?: string };
  };
  assert.equal(productionLifecycle.build.error, undefined, productionLifecycle.build.error);
  assert.equal(productionLifecycle.build.entrySha256, nextEntrySha256);
  const buildErrorLines = productionLifecycle.build.stderr?.split("\n").filter((line) =>
    line.startsWith("Module not found:") || line.startsWith("./") || line.startsWith("Error:") || line.startsWith("TypeError:") || line.startsWith(" ⨯") || line.startsWith("> ")
  ).slice(-40);
  assert.equal(productionLifecycle.build.exitCode, 0, JSON.stringify(buildErrorLines));
  for (const artifact of [".next/BUILD_ID", ".next/prerender-manifest.json", ".next/server/app/page.js"]) {
    assert.ok(productionLifecycle.build.files?.includes(artifact), `missing strict-CSP browser build artifact: ${artifact}`);
  }
  for (const [label, started] of [["start", productionLifecycle.firstStart], ["restart", productionLifecycle.restarted]] as const) {
    assert.equal(started?.error, undefined, `${label} worker transport failed: ${started?.error}`);
    assert.equal(started?.entrySha256, nextEntrySha256);
    assert.equal(started?.exitCode, 0, started?.stderr);
    const rootResponse = started?.responses?.root;
    assert.equal(rootResponse?.error, undefined, `${label} HTTP bridge failed: ${rootResponse?.error}`);
    assert.equal(rootResponse?.status, 200, `${started?.stderr || ""}\n${rootResponse?.output?.stderr || ""}\n${(rootResponse?.body || "").slice(0, 4_000)}`);
    assert.match(rootResponse?.body || "", /Strict CSP Next Runtime/);
    assert.match(rootResponse?.body || "", /config-plugin-ran/);
    assert.equal(rootResponse?.headers?.["x-powered-by"], undefined);
  }
  const featureResponses = productionLifecycle.firstStart?.responses || {};
  assert.equal(featureResponses.about?.status, 200, featureResponses.about?.output?.stderr);
  assert.equal(featureResponses.about?.headers?.["x-nuriteo-middleware"], "/about");
  assert.equal(featureResponses.legacy?.status, 200, featureResponses.legacy?.output?.stderr);
  assert.match(featureResponses.legacy?.body || "", /Pages Router Runtime/);
  assert.equal(featureResponses.edge?.status, 200, featureResponses.edge?.output?.stderr);
  assert.deepEqual(JSON.parse(featureResponses.edge?.body || "null"), { runtime: "edge", ok: true });
  assert.ok(featureResponses.actionId, "server action id was not rendered in strict-CSP Chrome");
  assert.equal(featureResponses.action?.status, 303, featureResponses.action?.output?.stderr);
  assert.equal(featureResponses.action?.headers?.["x-action-redirect"], "/action?message=hello;push");
  assert.equal(featureResponses.isrFresh?.headers?.["x-nextjs-cache"], "HIT");
  assert.equal(featureResponses.isrStale?.headers?.["x-nextjs-cache"], "STALE");
  assert.equal(featureResponses.isrRegenerated?.headers?.["x-nextjs-cache"], "HIT");
  assert.notEqual(featureResponses.isrFresh?.body, featureResponses.isrRegenerated?.body);
  assert.equal(featureResponses.image?.status, 200, featureResponses.image?.output?.stderr);
  assert.equal(featureResponses.image?.headers?.["content-type"], "image/png");
  assert.deepEqual(featureResponses.image?.bytes, [0x89, 0x50, 0x4e, 0x47]);
  console.log("production", JSON.stringify({
    buildArtifacts: productionLifecycle.build.files?.length,
    firstStartStatus: productionLifecycle.firstStart?.responses?.root?.status,
    restartStatus: productionLifecycle.restarted?.responses?.root?.status
  }));

  await assertWorkersReleased("command teardown");

  tamperFactoryResponse = true;
  const rejectedFactory = await runPreflight(4, "dev") as { error?: string };
  assert.equal(rejectedFactory.error, "ERR_NEXT_CSP_FACTORY_INTEGRITY");
  tamperFactoryResponse = false;
  await assertWorkersReleased("factory integrity rejection");

  const recovery = await runPreflight(5, "dev") as { result?: { exitCode?: number; stderr?: string } };
  assert.equal(recovery.result?.exitCode, 0, recovery.result?.stderr);
  await assertWorkersReleased("recovery teardown");
  assert.equal(await page.evaluate(() => crossOriginIsolated), true, "page did not recover after worker teardown/restart");
  await pageCdp.send("HeapProfiler.collectGarbage");
  const finalHeapBytes = (await pageCdp.send("Runtime.getHeapUsage")).usedSize;
  assert.ok(finalHeapBytes <= baselineHeapBytes + 256 * 1024 * 1024, `Chrome heap grew beyond the lifecycle budget: baseline=${baselineHeapBytes} final=${finalHeapBytes}`);
  console.log("soak", JSON.stringify({ baselineHeapBytes, finalHeapBytes, retainedWorkers: await workerTargetCount() - baselineTargets }));
} finally {
  await browser.close();
  await server.close();
}

console.log(`next browser-worker strict-CSP lifecycle passed entrySha256=${nextEntrySha256}`);
