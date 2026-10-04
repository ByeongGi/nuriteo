import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "@playwright/test";
import { build } from "esbuild";

import { previewBootstrapDocument } from "../src/runtime/preview-bootstrap-document.ts";
import { parsePreviewHost } from "../src/runtime/preview-origin-contract.ts";
import { issueSignedPreviewBinding, verifySignedPreviewBinding } from "../src/lib/preview/signed-binding.ts";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicRoot = path.join(webRoot, "public");
const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nuriteo-preview-origin-browser-"));
await build({
  bundle: true,
  entryPoints: [path.join(webRoot, "test/fixtures/runtime-journey.tsx")],
  format: "esm",
  jsx: "automatic",
  outfile: path.join(fixtureRoot, "fixture.js"),
  platform: "browser",
  target: "es2022"
});
fs.writeFileSync(path.join(fixtureRoot, "index.html"), '<!doctype html><meta charset="utf-8"><div id="root"></div><script type="module" src="/fixture.js"></script>\n');

const previewRequests: Array<{
  authorization: string | undefined;
  cookie: string | undefined;
  csrf: string | undefined;
  path: string;
}> = [];
const signingKey = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
let applicationOrigin = "";
const server = http.createServer((request, response) => {
  const host = (request.headers.host ?? "").replace(/:\d+$/u, "").toLowerCase();
  const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
  if (host === "app.localhost") {
    if (pathname === "/api/runtime-preview/bindings" && request.method === "POST") {
      void issueBinding(request, response);
      return;
    }
    serveApplication(pathname, response);
    return;
  }

  const binding = parsePreviewHost(host, "preview.localhost");
  if (!binding) {
    response.writeHead(404).end("not found");
    return;
  }
  void verifySignedPreviewBinding(signingKey, binding.runtimeId, binding.port).then((verification) => {
    if (verification !== "valid") {
      response.writeHead(verification === "expired" ? 410 : 404).end("not found");
      return;
    }
    servePreview(request, response, pathname, binding);
  });
});

function servePreview(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  pathname: string,
  binding: NonNullable<ReturnType<typeof parsePreviewHost>>
): void {
  previewRequests.push({
    authorization: request.headers.authorization,
    cookie: request.headers.cookie,
    csrf: request.headers["x-csrf-token"] as string | undefined,
    path: pathname
  });
  if (pathname === "/runtime-preview/bootstrap") {
    response.writeHead(200, previewHeaders("text/html; charset=utf-8"));
    response.end(previewBootstrapDocument({
      applicationOrigin,
      binding: binding.label,
      runtimeId: binding.runtimeId
    }));
    return;
  }
  if (pathname === "/runtime-preview/bootstrap.js" || pathname === "/runtime-preview/hmr.js" || pathname === "/runtime-preview/sw.js") {
    response.writeHead(200, {
      ...previewHeaders("text/javascript; charset=utf-8"),
      "Service-Worker-Allowed": "/"
    });
    response.end(fs.readFileSync(path.join(publicRoot, pathname)));
    return;
  }
  response.writeHead(404).end("not found");
}

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert(address && typeof address !== "string");
applicationOrigin = `http://app.localhost:${address.port}`;
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext();
  await context.addCookies([
    { name: "nuriteo_session", value: "must-not-cross-origin", url: applicationOrigin },
    { name: "nuriteo_dev_csrf", value: `nrt_csrf_${"A".repeat(43)}`, url: applicationOrigin }
  ]);
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  const workerVersions = new Map<string, { scriptURL: string; status: string }>();
  cdp.on("ServiceWorker.workerVersionUpdated", (event: { versions: Array<{ scriptURL: string; status: string; versionId: string }> }) => {
    for (const version of event.versions) workerVersions.set(version.versionId, version);
  });
  await cdp.send("ServiceWorker.enable");
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${applicationOrigin}/`, { waitUntil: "domcontentloaded" });
  assert.equal(await page.evaluate(() => globalThis.crossOriginIsolated), true);

  await page.getByRole("button", { name: "Start workspace" }).click();
  try {
    await page.getByRole("button", { name: "Run Preview" }).waitFor({ timeout: 20_000 });
  } catch (error) {
    throw new Error(`workspace did not start: ${await page.locator("body").innerText()} | ${errors.join(" | ")}`, { cause: error });
  }
  await page.evaluate(() => {
    const nativeNow = Date.now;
    Object.defineProperty(window, "__nuriteoNativeDateNow", { configurable: true, value: nativeNow });
    Date.now = () => nativeNow() + 10 * 60_000;
  });
  await page.getByRole("button", { name: "Run Preview" }).click();
  const previewRegion = page.getByRole("region", { name: "Preview" });
  try {
    await previewRegion.locator("iframe").waitFor({ timeout: 20_000 });
  } catch (error) {
    throw new Error(`isolated Preview iframe did not start: ${await previewRegion.textContent()} | page errors: ${errors.join(" | ")}`, { cause: error });
  }
  const externalUrl = await previewRegion.getAttribute("data-preview-url");
  assert(externalUrl);
  const previewOrigin = new URL(externalUrl).origin;
  assert.match(previewOrigin, new RegExp(`^http://r-[a-z2-7]{45}-p[1-9][0-9]*\\.preview\\.localhost:${address.port}$`, "u"));
  let previewFrame: import("@playwright/test").Frame;
  try {
    previewFrame = await waitForFrame(page, previewOrigin);
  } catch (error) {
    const frames = await Promise.all(page.frames().map(async (frame) => ({ body: await frame.locator("body").textContent().catch(() => null), url: frame.url() })));
    throw new Error(`Preview project frame did not attach: ${JSON.stringify(frames)} | ${errors.join(" | ")}`, { cause: error });
  }
  await page.evaluate(() => { Date.now = (window as unknown as { __nuriteoNativeDateNow: typeof Date.now }).__nuriteoNativeDateNow; });
  await previewFrame.locator("#root").getByText("nuriteo:1").waitFor({ timeout: 20_000 });
  assert.equal(await previewFrame.evaluate(() => document.cookie), "");
  assert.equal(await previewFrame.evaluate(() => globalThis.crossOriginIsolated), true);
  assert.equal(await previewFrame.evaluate(() => navigator.serviceWorker.controller?.scriptURL.endsWith("/runtime-preview/sw.js")), true);
  await page.getByRole("button", { name: "src/debug.ts" }).click();
  await page.getByLabel("Editor for src/debug.ts").fill([
    'import React from "react";',
    'export const lazy = () => import("react");',
    'export const label = "react";',
    'export const pattern = /from "react"/u;',
    '// import Fake from "react";',
    'export default React;',
    ''
  ].join("\n"));
  await page.getByRole("button", { name: "Apply to Local Draft" }).click();
  const rewrittenModule = await previewFrame.evaluate(async () => await (await fetch("/src/debug.ts")).text());
  assert.match(rewrittenModule, /import React from "\/node_modules\/react\/index\.js"/u);
  assert.match(rewrittenModule, /import\("\/node_modules\/react\/index\.js"\)/u);
  assert.match(rewrittenModule, /label = "react"/u, "ordinary string data must not be rewritten as a module specifier");
  assert.match(rewrittenModule, /pattern = \/from "react"\/u/u, "regex data must not be rewritten as a module specifier");
  assert.match(rewrittenModule, /\/\/ import Fake from "react"/u, "comment data must not be rewritten as a module specifier");
  assert.equal(await previewFrame.evaluate(async () => {
    const modulePath = "/src/debug.ts";
    return typeof (await import(modulePath)).lazy;
  }), "function");
  assert(previewRequests.length >= 3);
  for (const request of previewRequests) {
    assert.equal(request.cookie, undefined, `cookie leaked to Preview request ${request.path}`);
    assert.equal(request.authorization, undefined, `authorization leaked to Preview request ${request.path}`);
    assert.equal(request.csrf, undefined, `CSRF leaked to Preview request ${request.path}`);
  }

  const replayAccepted = await previewFrame.evaluate(async ({ appOrigin, generation }) => {
    const channel = new MessageChannel();
    const binding = location.hostname.split(".")[0] ?? "";
    const accepted = new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => resolve(false), 250);
      channel.port2.onmessage = () => { clearTimeout(timeout); resolve(true); };
    });
    parent.postMessage({
      type: "nuriteo-preview:connect",
      version: 1,
      binding,
      generation,
      nonce: "fedcba9876543210fedcba9876543210"
    }, appOrigin, [channel.port1]);
    return accepted;
  }, { appOrigin: applicationOrigin, generation: previewRuntimeId(externalUrl) });
  assert.equal(replayAccepted, false, "a second handshake must not replace the active relay");

  const serviceWorkerTakeoverAccepted = await previewFrame.evaluate(async ({ appOrigin, generation }) => {
    const channel = new MessageChannel();
    const binding = location.hostname.split(".")[0] ?? "";
    const accepted = new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => resolve(false), 250);
      channel.port2.onmessage = () => { clearTimeout(timeout); resolve(true); };
    });
    navigator.serviceWorker.controller?.postMessage({
      type: "nuriteo-preview:bind",
      version: 1,
      applicationOrigin: appOrigin,
      binding,
      generation,
      nonce: "abcdefabcdefabcdefabcdefabcdefab"
    }, [channel.port1]);
    return accepted;
  }, { appOrigin: applicationOrigin, generation: previewRuntimeId(externalUrl) });
  assert.equal(serviceWorkerTakeoverAccepted, false, "a second same-origin client bind must not replace the active SW relay");

  const documentTimeOrigin = await previewFrame.evaluate(() => {
    Object.defineProperty(window, "__nuriteoHmrApplied", { configurable: true, value: 0, writable: true });
    addEventListener("nuriteo-preview:hmr-applied", () => { (window as unknown as { __nuriteoHmrApplied: number }).__nuriteoHmrApplied += 1; });
    return performance.timeOrigin;
  });
  await previewFrame.getByRole("button", { name: "nuriteo:1" }).click();
  await previewFrame.getByRole("button", { name: "nuriteo:2" }).waitFor();
  await page.getByRole("button", { name: "src/message.ts" }).click();
  await page.getByLabel("Editor for src/message.ts").fill('export const label = "PRV001 cross origin";\n');
  await page.getByRole("button", { name: "Apply to Local Draft" }).click();
  await page.getByText("Local Draft saved · HMR applied", { exact: false }).waitFor({ timeout: 10_000 });
  await previewFrame.waitForFunction(() => (window as unknown as { __nuriteoHmrApplied: number }).__nuriteoHmrApplied === 1);
  assert.equal(await previewFrame.evaluate(() => performance.timeOrigin), documentTimeOrigin, "HMR must not replace the document");
  await previewFrame.getByRole("button", { name: "PRV001 cross origin:2" }).click();
  await previewFrame.getByRole("button", { name: "PRV001 cross origin:3" }).waitFor();
  const hmrCount = await previewFrame.evaluate(() => (window as unknown as { __nuriteoHmrApplied: number }).__nuriteoHmrApplied);
  await previewFrame.evaluate(({ appOrigin, generation }) => {
    parent.postMessage({
      type: "nuriteo-preview:hmr",
      version: 1,
      binding: location.hostname.split(".")[0],
      generation,
      path: "src/message.ts",
      sequence: 999
    }, appOrigin);
  }, { appOrigin: applicationOrigin, generation: previewRuntimeId(externalUrl) });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(await previewFrame.evaluate(() => (window as unknown as { __nuriteoHmrApplied: number }).__nuriteoHmrApplied), hmrCount, "window-message HMR injection must be ignored");

  await waitForStatus(address.port, new URL(externalUrl).host, "/runtime-preview/bootstrap", 410);
  const expiredRouteResponse = await previewFrame.goto(`${previewOrigin}/`, { waitUntil: "domcontentloaded" });
  assert.equal(expiredRouteResponse?.status(), 200, "an active session must keep Vite navigation alive after host expiry");
  assert.equal(await previewFrame.evaluate(async () => (await fetch("/runtime-preview/hmr.js")).status), 200, "active-session HMR must be served after signed-host expiry");
  assert.equal(await previewFrame.evaluate(async () => (await fetch("/src/App.tsx")).status), 200, "post-expiry non-root Vite assets must remain relayed");
  await previewFrame.getByRole("button", { name: "PRV001 cross origin:1" }).waitFor({ timeout: 20_000 });
  await previewFrame.evaluate(() => {
    Object.defineProperty(window, "__nuriteoHmrApplied", { configurable: true, value: 0, writable: true });
    addEventListener("nuriteo-preview:hmr-applied", () => { (window as unknown as { __nuriteoHmrApplied: number }).__nuriteoHmrApplied += 1; });
  });
  await page.getByLabel("Editor for src/message.ts").fill('export const label = "PRV001 expired route";\n');
  await page.getByRole("button", { name: "Apply to Local Draft" }).click();
  await previewFrame.waitForFunction(() => (window as unknown as { __nuriteoHmrApplied: number }).__nuriteoHmrApplied === 1);
  await previewFrame.getByRole("button", { name: "PRV001 expired route:1" }).waitFor();
  const workerVersionId = await waitForWorkerVersion(workerVersions, previewOrigin);
  await cdp.send("ServiceWorker.unregister", { scopeURL: `${previewOrigin}/` });
  await cdp.send("ServiceWorker.stopWorker", { versionId: workerVersionId });
  await page.waitForFunction((oldUrl) => {
    const nextUrl = document.querySelector<HTMLElement>('[aria-label="Preview"]')?.dataset.previewUrl;
    return Boolean(nextUrl && nextUrl !== oldUrl);
  }, externalUrl, { timeout: 15_000 });
  const recoveredUrl = await previewRegion.getAttribute("data-preview-url");
  assert(recoveredUrl && recoveredUrl !== externalUrl, "lost Service Worker relay must rotate to a fresh signed host");
  const recoveredOrigin = new URL(recoveredUrl).origin;
  const recoveredFrame = await waitForFrame(page, recoveredOrigin);
  await recoveredFrame.getByRole("button", { name: "PRV001 expired route:1" }).waitFor({ timeout: 20_000 });
  const recoveredTimeOrigin = await recoveredFrame.evaluate(() => {
    Object.defineProperty(window, "__nuriteoHmrApplied", { configurable: true, value: 0, writable: true });
    addEventListener("nuriteo-preview:hmr-applied", () => { (window as unknown as { __nuriteoHmrApplied: number }).__nuriteoHmrApplied += 1; });
    return performance.timeOrigin;
  });
  await page.getByLabel("Editor for src/message.ts").fill('export const label = "PRV001 recovered";\n');
  await page.getByRole("button", { name: "Apply to Local Draft" }).click();
  await recoveredFrame.waitForFunction(() => (window as unknown as { __nuriteoHmrApplied: number }).__nuriteoHmrApplied === 1);
  assert.equal(await recoveredFrame.evaluate(() => performance.timeOrigin), recoveredTimeOrigin);
  await recoveredFrame.getByRole("button", { name: "PRV001 recovered:1" }).click();
  await recoveredFrame.getByRole("button", { name: "PRV001 recovered:2" }).waitFor();
  const sustainedRelayStatus = await recoveredFrame.evaluate(async () => {
    for (let start = 0; start < 1_028; start += 4) {
      const responses = await Promise.all(Array.from({ length: 4 }, (_, offset) => fetch(`/src/message.ts?relay-sequence=${start + offset}`)));
      if (responses.some((response) => response.status !== 200)) return false;
    }
    return true;
  });
  assert.equal(sustainedRelayStatus, true, "more than 1024 monotonic requests must not terminate a healthy Preview");

  const blockedWebSocket = await recoveredFrame.evaluate(async () => {
    const violation = new Promise<string>((resolve) => addEventListener("securitypolicyviolation", (event) => resolve(`${event.violatedDirective}:${event.blockedURI}`), { once: true }));
    const socket = new WebSocket("ws://attacker.invalid/socket");
    socket.onerror = () => undefined;
    return Promise.race([violation, new Promise<string>((resolve) => setTimeout(() => resolve("missing"), 2_000))]);
  });
  assert.match(blockedWebSocket, /^connect-src:ws:\/\/attacker\.invalid/u);

  await page.evaluate(() => {
    const nativeFetch = window.fetch.bind(window);
    Object.defineProperty(window, "__nuriteoNativeFetch", { configurable: true, value: nativeFetch });
    window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("/__preview/") && String(input).includes("hold-relay")) {
        return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true }));
      }
      return nativeFetch(input, init);
    }) as typeof fetch;
  });
  const capacityStatus = await recoveredFrame.evaluate(async () => {
    const requests = Array.from({ length: 9 }, (_, index) => fetch(`/hold-relay-${index}`));
    return (await Promise.race([
      Promise.any(requests.map(async (request) => {
        const status = (await request).status;
        if (status !== 429) return new Promise<number>(() => undefined);
        return status;
      })),
      new Promise<number>((resolve) => setTimeout(() => resolve(0), 3_000))
    ]));
  });
  assert.equal(capacityStatus, 429, "relay concurrency must fail excess work deterministically");

  await page.getByRole("button", { name: "Stop workspace" }).click();
  try {
    await page.getByRole("button", { name: "Start workspace" }).waitFor({ timeout: 10_000 });
  } catch (error) {
    throw new Error(`workspace did not stop: ${await page.locator("body").innerText()} | ${errors.join(" | ")}`, { cause: error });
  }
  await page.waitForFunction(() => window.__nuriteoRuntimeProbe.activeWorkers === 0);
  const stalePage = await context.newPage();
  const staleResponse = await stalePage.goto(externalUrl, { waitUntil: "domcontentloaded" });
  assert.equal(staleResponse?.status(), 410, "expired stopped Preview host must fail closed");
  assert.equal(await stalePage.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length), 0, "stopped Preview origin must unregister its Service Worker");
  await stalePage.close();
  assert.deepEqual(errors, []);

  assert.equal(await requestStatus(address.port, `r-${"a".repeat(45)}-p4173.preview.localhost`, "/_next/static/hostile.js"), 404);
  assert.equal(await requestStatus(address.port, `project.r-${"a".repeat(45)}-p4173.preview.localhost`, "/"), 404);
  console.log("PRV-001 actual cross-origin browser journey ok (wildcard host, SW relay, HMR, replay/capacity/credential isolation, dispose)");
} finally {
  await browser.close();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  fs.rmSync(fixtureRoot, { force: true, recursive: true });
}

async function issueBinding(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const csrf = request.headers["x-csrf-token"];
  if (request.headers.origin !== applicationOrigin
      || request.headers["content-type"] !== "application/json"
      || csrf !== `nrt_csrf_${"A".repeat(43)}`
      || !request.headers.cookie?.includes(`nuriteo_dev_csrf=nrt_csrf_${"A".repeat(43)}`)) {
    response.writeHead(403).end("rejected");
    return;
  }
  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { port?: unknown };
  if (!Number.isInteger(parsed.port)) {
    response.writeHead(400).end("rejected");
    return;
  }
  const binding = await issueSignedPreviewBinding(signingKey, parsed.port as number);
  response.writeHead(201, { "Cache-Control": "no-store", "Content-Type": "application/json" }).end(JSON.stringify({
    runtimeId: binding.runtimeId,
    ttlMs: Math.max(1, binding.expiresAt - Date.now())
  }));
}

function serveApplication(pathname: string, response: http.ServerResponse): void {
  response.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  const root = pathname.startsWith("/runtime/") ? publicRoot : fixtureRoot;
  const relative = pathname === "/" ? "index.html" : pathname.slice(1);
  const resolved = path.resolve(root, relative);
  if (!resolved.startsWith(`${root}${path.sep}`) || !fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    response.writeHead(404).end("not found");
    return;
  }
  if (pathname.endsWith("preview-sw.js")) response.setHeader("Service-Worker-Allowed", "/");
  response.setHeader("Content-Type", contentType(resolved));
  response.end(fs.readFileSync(resolved));
}

function previewHeaders(contentTypeValue: string): Record<string, string> {
  return {
    "Cache-Control": "no-store",
    "Content-Security-Policy": `default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; worker-src 'self'; frame-src 'self'; connect-src 'self'; frame-ancestors 'self' ${applicationOrigin}; base-uri 'none'; form-action 'none'`,
    "Content-Type": contentTypeValue,
    "Cross-Origin-Embedder-Policy": "require-corp",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "cross-origin",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff"
  };
}

function contentType(file: string): string {
  if (file.endsWith(".html")) return "text/html; charset=utf-8";
  if (file.endsWith(".js") || file.endsWith(".mjs")) return "text/javascript; charset=utf-8";
  if (file.endsWith(".wasm")) return "application/wasm";
  if (file.endsWith(".json")) return "application/json; charset=utf-8";
  return "application/octet-stream";
}

function requestStatus(port: number, host: string, requestPath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: "127.0.0.1", port, path: requestPath, headers: { Host: `${host}:${port}` } }, (response) => {
      response.resume();
      response.on("end", () => resolve(response.statusCode ?? 0));
    });
    request.on("error", reject);
    request.end();
  });
}

async function waitForFrame(page: import("@playwright/test").Page, origin: string): Promise<import("@playwright/test").Frame> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const frame = page.frames().find((candidate) => {
      try {
        const url = new URL(candidate.url());
        return url.origin === origin && url.pathname === "/";
      } catch { return false; }
    });
    if (frame) return frame;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Preview frame at ${origin} was not attached`);
}

async function waitForStatus(port: number, host: string, requestPath: string, expected: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await requestStatus(port, host.replace(/:\d+$/u, ""), requestPath) === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Preview host did not reach HTTP ${expected}`);
}

async function waitForWorkerVersion(
  versions: ReadonlyMap<string, { scriptURL: string; status: string }>,
  origin: string
): Promise<string> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    for (const [versionId, version] of versions) {
      if (version.scriptURL === `${origin}/runtime-preview/sw.js` && version.status === "activated") return versionId;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Preview Service Worker version was not observed");
}

function previewRuntimeId(url: string): string {
  const value = /^r-([a-z2-7]{45})-p[1-9][0-9]{0,4}$/u.exec(new URL(url).hostname.split(".")[0] ?? "")?.[1];
  assert(value);
  return value;
}
