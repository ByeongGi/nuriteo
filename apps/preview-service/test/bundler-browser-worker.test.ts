#!/usr/bin/env node
import assert from "node:assert/strict";
import path from "node:path";

import { chromium } from "@playwright/test";
import { createServer } from "../node_modules/vite/dist/node/index.js";
import { REQUIRED_RUNTIME_HEADERS } from "../../../packages/browser-host/src/security/headers.ts";

const root = path.resolve(new URL("../../..", import.meta.url).pathname);
const chromePath = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const projectRoot = "/workspace/project";
const lane = process.env.BUNDLER_LANE === "webpack" ? "webpack" : "rspack";
const laneConfig = lane === "webpack"
  ? { devArgs: ["serve", "--mode", "development", "--devtool", "false", "--entry", "./src/index.js", "--host", "127.0.0.1", "--port", "49321", "--allowed-hosts", "all"], entry: `${projectRoot}/node_modules/webpack-cli/bin/cli.js`, mode: "cjs", version: "5.111.0" }
  : { devArgs: ["serve", "--mode", "development", "--devtool", "false", "--entry", "./src/index.js", "--host", "127.0.0.1", "--port", "49321"], entry: `${projectRoot}/node_modules/@rspack/cli/bin/rspack.js`, mode: "esm", version: "2.2.4" };
let servedBundle = Buffer.alloc(0);
let tamperFactory = false;

function assertHmrSequence(types: string[], label: string): void {
  const invalidIndex = types.indexOf("invalid");
  const hashIndex = types.lastIndexOf("hash");
  const okIndex = types.lastIndexOf("ok");
  assert.ok(types.every((type) => ["invalid", "still-ok", "hash", "ok"].includes(type)), `${label} emitted an unexpected event: ${types.join(", ")}`);
  assert.ok(invalidIndex >= 0, `${label} did not invalidate`);
  assert.ok(hashIndex > invalidIndex, `${label} did not publish a hash after invalidation`);
  assert.ok(okIndex > hashIndex, `${label} did not complete after publishing its hash`);
}

const server = await createServer({
  configFile: false,
  plugins: [{
    name: "bundler-browser-worker-security-headers",
    configureServer(vite) {
      vite.middlewares.use((request, response, next) => {
        response.setHeader("Cross-Origin-Opener-Policy", REQUIRED_RUNTIME_HEADERS.coop);
        response.setHeader("Cross-Origin-Embedder-Policy", REQUIRED_RUNTIME_HEADERS.coep);
        response.setHeader("Content-Security-Policy", REQUIRED_RUNTIME_HEADERS.csp);
        if (request.url?.startsWith("/bundler-production.js")) {
          response.setHeader("Content-Type", "text/javascript; charset=utf-8");
          response.end(servedBundle);
          return;
        }
        if (tamperFactory && request.url?.startsWith(`/vendor/${lane}-${laneConfig.version}/cli-static-factories.mjs`)) {
          response.setHeader("Content-Type", "text/javascript; charset=utf-8");
          response.end("export const bundler = 'tampered';\n");
          return;
        }
        if (request.url === "/bundler-browser-worker") {
          response.setHeader("Content-Type", "text/html");
          response.end("<!doctype html><html><body>Bundler browser worker</body></html>");
          return;
        }
        next();
      });
    }
  }],
  publicDir: path.join(root, "apps/preview-service/public"),
  root,
  server: { host: "127.0.0.1", port: 0 }
});

await server.listen();
const browser = await chromium.launch({ executablePath: chromePath, headless: true });
try {
  const page = await browser.newPage();
  page.on("console", (message) => process.stderr.write(`[browser:${message.type()}] ${message.text()}\n`));
  page.on("worker", (worker) => process.stderr.write(`[browser:worker] ${worker.url()}\n`));
  const origin = server.resolvedUrls.local[0];
  await page.goto(`${origin}bundler-browser-worker`, { waitUntil: "load" });
  assert.equal(await page.evaluate(() => globalThis.crossOriginIsolated), true);
  const cdp = await browser.newBrowserCDPSession();
  const workerTargetCount = async () => (await cdp.send("Target.getTargets")).targetInfos
    .filter((target) => target.type === "worker").length;
  const baselineTargets = await workerTargetCount();
  const initialHeap = await page.evaluate(() => (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize || 0);
  const assertWorkersReleased = async (label: string) => {
    let count = await workerTargetCount();
    for (let attempt = 0; count > baselineTargets && attempt < 50; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      count = await workerTargetCount();
    }
    assert.equal(count, baselineTargets, `${lane} retained browser worker targets after ${label}`);
  };

  const runBuild = (id: number) => page.evaluate(async ({ config, id, lane, projectRoot }) => {
    const encode = (data: string) => ({ data, path: "" });
    const files = [
      { path: `${projectRoot}/package.json`, data: JSON.stringify({ name: `${lane}-browser-smoke`, private: true }) },
      { path: `${projectRoot}/src/index.js`, data: `globalThis.__bundlerBuild = '${lane}-browser-pass';` }
    ].map((file) => ({ ...encode(file.data), path: file.path }));
    const worker = new Worker("/workers/process-worker.ts", { type: "module" });
    return await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Rspack browser worker timed out")), 60000);
      worker.addEventListener("error", (event) => {
        clearTimeout(timeout);
        reject(new Error(event.message));
      });
      worker.addEventListener("message", (event) => {
        if (event.data?.type !== "cli:result" || event.data.id !== id) return;
        clearTimeout(timeout);
        worker.terminate();
        resolve(event.data);
      });
      worker.postMessage({
        id,
        readyTimeoutMs: 30000,
        root: "/workspace",
        settleTicks: 12,
        settleTimeoutMs: 3000,
        type: "cli:evaluate",
        request: {
          args: ["build", "--mode", "production"],
          cwd: projectRoot,
          entry: { name: lane, version: config.version, mode: config.mode, entry: config.entry }
        },
        workspaceSnapshot: {
          directories: ["/", "/workspace", projectRoot, `${projectRoot}/src`],
          files,
          links: []
        }
      });
    });
  }, { config: laneConfig, id, lane, projectRoot });
  const result = await runBuild(1) as any;
  process.stdout.write(`${JSON.stringify({
    error: result.error,
    exitCode: result.result?.exitCode,
    stderr: result.result?.stderr,
    stdout: result.result?.stdout
  }, null, 2)}\n`);
  assert.equal(result.error, undefined);
  assert.equal(result.result?.exitCode, 0);
  const output = result.result?.workspaceSnapshot?.files?.find((file) => file.path === `${projectRoot}/dist/main.js`);
  assert.ok(output, `${lane} did not emit dist/main.js; files=${result.result?.workspaceSnapshot?.files?.map((file) => file.path).filter((file) => file.includes("/dist/"))?.join(",") || "none"}`);
  servedBundle = Buffer.from(output.data, "base64");
  await page.evaluate(async ({ lane }) => {
    await new Promise<void>((resolve, reject) => {
      const script = document.createElement("script");
      script.src = `/bundler-production.js?lane=${lane}`;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error("production preview script failed to execute"));
      document.head.append(script);
    });
  }, { lane });
  assert.equal(await page.evaluate(() => (globalThis as any).__bundlerBuild), `${lane}-browser-pass`);
  await assertWorkersReleased("production build");

  const runDev = () => page.evaluate(async ({ config, lane, projectRoot }) => {
    const files = [
      { path: `${projectRoot}/package.json`, data: JSON.stringify({ name: `${lane}-browser-dev`, private: true }) },
      { path: `${projectRoot}/src/index.js`, data: `globalThis.__bundlerDev = '${lane}-dev-before';` }
    ];
    const worker = new Worker("/workers/process-worker.ts", { type: "module" });
    const pending: unknown[] = [];
    const waiters: Array<{ predicate: (message: unknown) => boolean; resolve: (message: unknown) => void }> = [];
    worker.addEventListener("message", (event) => {
      const index = waiters.findIndex((waiter) => waiter.predicate(event.data));
      if (index >= 0) waiters.splice(index, 1)[0]!.resolve(event.data);
      else pending.push(event.data);
    });
    const waitFor = (predicate: (message: unknown) => boolean, timeoutMs = 60000): Promise<unknown> => {
      const index = pending.findIndex(predicate);
      if (index >= 0) return Promise.resolve(pending.splice(index, 1)[0]);
      return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`${lane} dev worker timed out`)), timeoutMs);
        waiters.push({ predicate, resolve: (message) => { clearTimeout(timeout); resolve(message); } });
      });
    };
    try {
      worker.postMessage({
        bridgeLoopbackServer: true,
        id: 2,
        readyTimeoutMs: 60000,
        root: "/workspace",
        settleTicks: 12,
        settleTimeoutMs: 3000,
        type: "cli:evaluate",
        request: {
          args: config.devArgs,
          cwd: projectRoot,
          entry: { name: lane, version: config.version, mode: config.mode, entry: config.entry }
        },
        workspaceSnapshot: {
          directories: ["/", "/workspace", projectRoot, `${projectRoot}/src`],
          files,
          links: []
        }
      });
      const result = await waitFor((message: any) => message?.type === "cli:result" && message.id === 2) as any;
      if (result.error) throw new Error(result.error);
      const port = result.result?.bridgedServerPorts?.[0];
      if (!port) return { result: { exitCode: result.result?.exitCode, stderr: result.result?.stderr, stdout: result.result?.stdout }, port: null };
      worker.postMessage({ evaluationId: 2, headers: { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}` }, id: 30, path: "/ws", port, type: "cli:ws:connect" });
      const initialSocketMessage = await waitFor((message: any) => message?.id === 30 && String(message?.type || "").startsWith("cli:ws:")) as any;
      if (initialSocketMessage.type !== "cli:ws:message") {
        return { initialSocketMessage, port, result: { exitCode: result.result?.exitCode, stderr: result.result?.stderr, stdout: result.result?.stdout } };
      }
      const initialTypes = [JSON.parse(initialSocketMessage.data).type];
      while (!initialTypes.includes("ok") && initialTypes.length < 12) {
        const message = await waitFor((candidate: any) => candidate?.type === "cli:ws:message" && candidate.id === 30) as any;
        initialTypes.push(JSON.parse(message.data).type);
      }
      worker.postMessage({ evaluationId: 2, id: 20, port, request: { headers: { host: `127.0.0.1:${port}` }, method: "GET", path: "/main.js" }, type: "cli:http:request" });
      const response = await waitFor((message: any) => message?.type === "cli:http:response" && message.id === 20) as any;
      worker.postMessage({ data: `globalThis.__bundlerDev = '${lane}-dev-after';`, evaluationId: 2, id: 21, path: `${projectRoot}/src/index.js`, type: "cli:fs:write" });
      const write = await waitFor((message: any) => message?.type === "cli:fs:write:result" && message.id === 21) as any;
      const updateTypes: string[] = [];
      try {
        while (!updateTypes.includes("ok") && updateTypes.length < 12) {
          const message = await waitFor((candidate: any) => candidate?.type === "cli:ws:message" && candidate.id === 30, 10000) as any;
          updateTypes.push(JSON.parse(message.data).type);
        }
      } catch (error) {
        updateTypes.push(`timeout:${error instanceof Error ? error.message : String(error)}`);
      }
      worker.postMessage({ evaluationId: 2, id: 22, port, request: { headers: { host: `127.0.0.1:${port}` }, method: "GET", path: "/main.js" }, type: "cli:http:request" });
      const updatedResponse = await waitFor((message: any) => message?.type === "cli:http:response" && message.id === 22) as any;
      return {
        initialTypes,
        port,
        response: { error: response.error, statusCode: response.response?.statusCode },
        updatedBody: updatedResponse.response?.body ? new TextDecoder().decode(updatedResponse.response.body) : "",
        result: { exitCode: result.result?.exitCode, stderr: result.result?.stderr, stdout: result.result?.stdout },
        updateTypes,
        write
      };
    } finally {
      worker.terminate();
    }
  }, { config: laneConfig, lane, projectRoot });
  const dev = await runDev() as any;
  const devBundle = dev.updatedBody as string;
  dev.updatedBodyIncludesAfter = devBundle.includes(`${lane}-dev-after`);
  delete dev.updatedBody;
  process.stdout.write(`${JSON.stringify(dev, null, 2)}\n`);
  assert.ok(dev.port, `${lane} dev server returned no bridged port`);
  assert.equal(dev.response?.statusCode, 200);
  assertHmrSequence(dev.updateTypes, `${lane} dev HMR`);
  assert.equal(dev.updatedBodyIncludesAfter, true);
  assert.doesNotMatch(devBundle, /\beval\s*\(/, `${lane} dev bundle contains CSP-blocked eval`);
  servedBundle = Buffer.from(devBundle);
  await page.evaluate(async ({ lane }) => {
    delete (globalThis as any).__bundlerDev;
    await new Promise<void>((resolve, reject) => {
      const script = document.createElement("script");
      script.src = `/bundler-production.js?lane=${lane}&mode=dev`;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error("dev preview script failed to execute under CSP"));
      document.head.append(script);
    });
  }, { lane });
  assert.equal(await page.evaluate(() => (globalThis as any).__bundlerDev), `${lane}-dev-after`);
  assert.doesNotMatch(dev.write?.result?.output?.stderr || "", /<e>|TypeError|EvalError/);
  await assertWorkersReleased("dev teardown");

  const restart = await runDev() as any;
  restart.updatedBodyIncludesAfter = String(restart.updatedBody).includes(`${lane}-dev-after`);
  delete restart.updatedBody;
  assert.equal(restart.response?.statusCode, 200);
  assertHmrSequence(restart.updateTypes, `${lane} restart HMR`);
  assert.equal(restart.updatedBodyIncludesAfter, true);
  await assertWorkersReleased("dev restart teardown");

  tamperFactory = true;
  const rejected = await runBuild(3) as any;
  assert.equal(rejected.error, `ERR_${lane.toUpperCase()}_CSP_FACTORY_INTEGRITY`);
  tamperFactory = false;
  await assertWorkersReleased("factory integrity rejection");

  const recovery = await runBuild(4) as any;
  assert.equal(recovery.error, undefined);
  assert.equal(recovery.result?.exitCode, 0, recovery.result?.stderr);
  await assertWorkersReleased("integrity recovery");

  await page.evaluate(async ({ config, lane, projectRoot }) => {
    const worker = new Worker("/workers/process-worker.ts", { type: "module" });
    worker.postMessage({
      bridgeLoopbackServer: true,
      id: 99,
      type: "cli:evaluate",
      request: { args: config.devArgs, cwd: projectRoot, entry: { entry: config.entry, mode: config.mode, name: lane, version: config.version } },
      workspaceSnapshot: {
        directories: ["/", "/workspace", projectRoot, `${projectRoot}/src`],
        files: [
          { path: `${projectRoot}/package.json`, data: JSON.stringify({ name: `${lane}-cancel`, private: true }) },
          { path: `${projectRoot}/src/index.js`, data: "globalThis.__cancelProbe = true;" }
        ],
        links: []
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    worker.terminate();
  }, { config: laneConfig, lane, projectRoot });
  await assertWorkersReleased("cancellation");
  const finalHeap = await page.evaluate(() => (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize || 0);
  if (initialHeap && finalHeap) assert.ok(finalHeap - initialHeap < 800 * 1024 * 1024, `${lane} browser heap grew by more than 800 MiB`);
} finally {
  await browser.close();
  await server.close();
}
