import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "@playwright/test";
import { build } from "esbuild";
import { NextProductWorkflow } from "../../../packages/node-runtime/src/frameworks/next-workflow.ts";

import { issueSignedPreviewBinding, verifySignedPreviewBinding } from "../src/lib/preview/signed-binding.ts";
import { previewBootstrapDocument } from "../src/runtime/preview-bootstrap-document.ts";
import { parsePreviewHost } from "../src/runtime/preview-origin-contract.ts";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicRoot = path.join(webRoot, "public");
const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nuriteo-preview-next-"));
await build({
  bundle: true,
  entryPoints: [path.join(webRoot, "test/fixtures/preview-next-isolation.ts")],
  format: "esm",
  outfile: path.join(outputRoot, "fixture.js"),
  platform: "browser",
  target: "es2022"
});

const workflow = new NextProductWorkflow({ manager: "pnpm", initialTitle: "Next.js" });
workflow.install();
workflow.startDevServerFromPackageScript("dev");
const signingKey = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const internalPrefix = "/__preview/019a4a82-1640-7000-8000-000000000032%3A019a4a82-1640-7000-8000-000000000031/3045";
let applicationOrigin = "";

const server = http.createServer((request, response) => {
  const host = (request.headers.host ?? "").replace(/:\d+$/u, "").toLowerCase();
  const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
  if (host === "app.localhost") {
    if (pathname === "/api/runtime-preview/bindings" && request.method === "POST") { void issueBinding(request, response); return; }
    if (pathname === "/fixture.js") return file(response, path.join(outputRoot, "fixture.js"), "text/javascript; charset=utf-8");
    if (pathname.startsWith(internalPrefix)) {
      const route = pathname.slice(internalPrefix.length) || "/";
      const preview = workflow.preview(route);
      response.writeHead(preview.statusCode, preview.headers).end(preview.body);
      return;
    }
    response.writeHead(200, appHeaders("text/html; charset=utf-8")).end('<!doctype html><body><script type="module" src="/fixture.js"></script></body>');
    return;
  }
  const binding = parsePreviewHost(host, "preview.localhost");
  if (!binding) { response.writeHead(404).end(); return; }
  void verifySignedPreviewBinding(signingKey, binding.runtimeId, binding.port).then((verification) => {
    if (verification !== "valid") { response.writeHead(verification === "expired" ? 410 : 404).end(); return; }
    if (pathname === "/runtime-preview/bootstrap") {
      response.writeHead(200, bootstrapHeaders()).end(previewBootstrapDocument({ applicationOrigin, binding: binding.label, runtimeId: binding.runtimeId }));
      return;
    }
    if (["/runtime-preview/bootstrap.js", "/runtime-preview/hmr.js", "/runtime-preview/sw.js"].includes(pathname)) {
      file(response, path.join(publicRoot, pathname), "text/javascript; charset=utf-8", pathname.endsWith("sw.js") ? { "Service-Worker-Allowed": "/" } : {});
      return;
    }
    response.writeHead(404).end();
  });
});

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert(address && typeof address !== "string");
applicationOrigin = `http://app.localhost:${address.port}`;
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext();
  await context.addCookies([{ name: "nuriteo_dev_csrf", value: `nrt_csrf_${"A".repeat(43)}`, url: applicationOrigin }]);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(applicationOrigin, { waitUntil: "domcontentloaded" });
  try {
    await page.waitForFunction(() => document.body.dataset.previewUrl !== undefined, undefined, { timeout: 10_000 });
  } catch (error) {
    throw new Error(`Next Preview binding did not start: ${errors.join(" | ")} | ${await page.locator("body").innerText()}`, { cause: error });
  }
  const externalUrl = await page.locator("body").getAttribute("data-preview-url");
  assert(externalUrl);
  const origin = new URL(externalUrl).origin;
  const projectFrame = await waitForFrame(page, origin, "/");
  await projectFrame.getByRole("heading", { name: "Next.js" }).waitFor({ timeout: 20_000 });
  const aboutResponse = await projectFrame.goto(`${origin}/about`, { waitUntil: "domcontentloaded" });
  assert.equal(aboutResponse?.status(), 200);
  await projectFrame.getByRole("heading", { name: "About" }).waitFor();
  assert.equal(await projectFrame.evaluate(() => (window as unknown as { __NEXT_PREVIEW_ROUTE__?: string }).__NEXT_PREVIEW_ROUTE__), "/about");
  assert.equal(await projectFrame.evaluate(() => [...document.scripts].filter((script) => !script.src).every((script) => script.nonce.length > 0)), true);
  assert.equal(await projectFrame.evaluate(() => globalThis.crossOriginIsolated), true);
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
  workflow.stopDevServer();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  fs.rmSync(outputRoot, { force: true, recursive: true });
}

async function issueBinding(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  if (request.headers.origin !== applicationOrigin || request.headers["x-csrf-token"] !== `nrt_csrf_${"A".repeat(43)}`) {
    response.writeHead(403).end(); return;
  }
  const input = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { port: number };
  const binding = await issueSignedPreviewBinding(signingKey, input.port, Date.now(), 20_000);
  response.writeHead(201, { "content-type": "application/json" }).end(JSON.stringify({ runtimeId: binding.runtimeId, ttlMs: binding.expiresAt - Date.now() }));
}

function appHeaders(contentType: string): Record<string, string> {
  return { "content-type": contentType, "cross-origin-embedder-policy": "require-corp", "cross-origin-opener-policy": "same-origin", "cross-origin-resource-policy": "same-origin" };
}

function bootstrapHeaders(): Record<string, string> {
  return { ...appHeaders("text/html; charset=utf-8"), "content-security-policy": `default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; worker-src 'self'; frame-src 'self'; connect-src 'self'; frame-ancestors 'self' ${applicationOrigin}; base-uri 'none'; form-action 'none'`, "cross-origin-resource-policy": "cross-origin" };
}

function file(response: http.ServerResponse, filename: string, contentType: string, headers: Record<string, string> = {}): void {
  response.writeHead(200, { ...appHeaders(contentType), ...headers }).end(fs.readFileSync(filename));
}

async function waitForFrame(page: import("@playwright/test").Page, origin: string, pathname: string): Promise<import("@playwright/test").Frame> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const frame = page.frames().find((candidate) => {
      try { const url = new URL(candidate.url()); return url.origin === origin && url.pathname === pathname; } catch { return false; }
    });
    if (frame) return frame;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Next Preview frame ${origin}${pathname} was not attached`);
}

console.log("PRV-001 actual isolated Next non-root route ok");
