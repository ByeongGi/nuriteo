import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "@playwright/test";
import { build } from "esbuild";

declare global {
  interface Window { __nuriteoRuntimeProbe: { activeWorkers: number; createdWorkers: number; committedVersion?: number; committedEtag?: string; reloads: number; restoreMode: "download-failure" | "intervening" | "materialization-failure" | "success" } }
}

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicRoot = path.join(webRoot, "public");
const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nuriteo-runtime-browser-"));
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

const csrf = `nrt_csrf_${"s".repeat(43)}`;
const saveSessionId = "0199ee6c-c777-7000-8000-00000000b003";
const bundleId = "0199ee6c-c777-7000-8000-00000000b004";
const historyVersionId = "0199ee6c-c777-7000-8000-00000000b006";
const saveRequests: string[] = [];
let createAttempts = 0;
const server = http.createServer(async (request, response) => {
  response.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
  if (pathname.endsWith("/versions") && request.method === "GET") {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ items: [{ id: historyVersionId, projectId: "0199ee6c-c777-7000-8000-00000000b002", bundleId, name: "Before refactor", createdByUserId: "0199ee6c-c777-7000-8000-00000000b001", sourceProjectVersion: 1, createdAt: "2026-10-04T00:00:00Z", sha256: "a".repeat(64), physicalBytes: 100, logicalBytes: 50, fileCount: 1, format: "project-bundle-v1" }], nextCursor: null }));
    return;
  }
  if (pathname.endsWith("/recovery-checkpoints") && request.method === "GET") {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ items: [] }));
    return;
  }
  if (pathname.includes("/save-sessions")) {
    saveRequests.push(`${request.method} ${pathname}`);
    assert.equal(request.headers["x-csrf-token"], csrf);
    if (pathname.endsWith("/save-sessions") && request.method === "POST") {
      createAttempts += 1;
      assert.equal(request.headers["if-match"], createAttempts < 3 ? '"project-v1"' : '"project-v2"');
      assert.match(String(request.headers["idempotency-key"]), new RegExp(`^bundle-v${createAttempts < 3 ? 1 : 2}-[0-9a-f]{64}$`, "u"));
      if (createAttempts === 1) return problem(response, 503, "SERVICE_UNAVAILABLE");
      if (createAttempts === 3) return problem(response, 412, "PROJECT_VERSION_STALE");
      const body = await requestJson(request);
      response.statusCode = 201;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        expiresAt: "2026-10-04T12:00:00Z", idempotentRetry: false, partCount: 1,
        sessionId: saveSessionId, uploadMode: "single", upload: {
          transport: "direct",
          method: "PUT", url: "https://storage.test/runtime-save", expectedBytes: body.physicalBytes,
          headers: [{ name: "x-amz-checksum-sha256", value: body.sha256 }]
        }
      }));
      return;
    }
    if (pathname.endsWith(`/${saveSessionId}/complete`) && request.method === "POST") {
      problem(response, 503, "COMMIT_OUTCOME_UNKNOWN");
      return;
    }
    if (pathname.endsWith(`/${saveSessionId}/reconcile`) && request.method === "POST") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ state: "committed", bundleId, projectVersion: 2 }));
      return;
    }
  }
  if (pathname.endsWith("/history/restore") && request.method === "POST") {
    assert.equal(request.headers["x-csrf-token"], csrf);
    assert.equal(request.headers["if-match"], '"project-v2"');
    response.setHeader("content-type", "application/json");
    response.setHeader("etag", '"project-v3"');
    response.end(JSON.stringify({ operationId: "0199ee6c-c777-7000-8000-00000000b007", referenceKind: "version", referenceId: historyVersionId, bundleId, projectVersion: 3, changed: true, idempotentRetry: false }));
    return;
  }
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
});

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert(address && typeof address !== "string");
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  const applicationOrigin = `http://app.localhost:${address.port}`;
  await page.context().addCookies([{ name: "nuriteo_dev_csrf", value: csrf, url: applicationOrigin }]);
  await page.route("https://storage.test/runtime-save", async (route) => {
    if (route.request().method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers: {
        "access-control-allow-origin": applicationOrigin,
        "access-control-allow-methods": "PUT",
        "access-control-allow-headers": "x-amz-checksum-sha256"
      } });
      return;
    }
    assert.equal(route.request().method(), "PUT");
    assert.ok((await route.request().postDataBuffer())?.byteLength);
    await route.fulfill({ status: 200, headers: {
      "access-control-allow-origin": applicationOrigin,
      "access-control-expose-headers": "etag,x-amz-checksum-sha256",
      etag: '"runtime-upload"'
    } });
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${applicationOrigin}/`, { waitUntil: "domcontentloaded" });
  assert.equal(await page.evaluate(() => globalThis.crossOriginIsolated), true);

  await page.getByRole("button", { name: "Start workspace from template", exact: true }).click();
  await page.getByRole("button", { name: "Run Preview" }).waitFor({ timeout: 20_000 });
  assert.equal(await page.evaluate(() => window.__nuriteoRuntimeProbe.createdWorkers), 2);

  await page.getByRole("button", { name: "src/message.ts" }).click();
  const editor = page.getByLabel("Editor for src/message.ts");
  await editor.fill('export const label = "RT004 edited";\n');
  await page.getByRole("button", { name: "Apply to Local Draft" }).click();
  await page.getByText("Local Draft saved", { exact: false }).waitFor({ timeout: 10_000 });
  await page.getByRole("button", { name: "Save to server" }).click();
  await page.getByText("Server Save failed · Local Draft preserved", { exact: true }).waitFor({ timeout: 20_000 });
  await page.getByRole("button", { name: "Retry Server Save" }).click();
  await page.getByText("Server Save v2 complete · Local Draft is current", { exact: true }).waitFor({ timeout: 20_000 });
  assert.deepEqual(await page.evaluate(() => ({
    etag: window.__nuriteoRuntimeProbe.committedEtag,
    version: window.__nuriteoRuntimeProbe.committedVersion
  })), { etag: '"project-v2"', version: 2 });
  assert.ok(saveRequests.some((entry) => entry.endsWith("/reconcile")), "unknown Save completion must reconcile");

  await editor.fill('export const label = "newer local draft";\n');
  await page.getByRole("button", { name: "Apply to Local Draft" }).click();
  await page.getByRole("button", { name: "Save to server" }).click();
  await page.getByText(/Server Project changed before this Save/u).waitFor({ timeout: 20_000 });
  await page.getByRole("button", { name: "Reload latest Project" }).click();
  assert.equal(await page.evaluate(() => window.__nuriteoRuntimeProbe.reloads), 1);

  const historyVersion = page.locator("li", { hasText: "Before refactor" });
  await historyVersion.getByRole("button", { name: "Restore" }).click();
  await page.getByRole("button", { name: "Restore Server Working Head" }).click();
  await page.getByText("Server Working Head is now v3. The browser Local Draft was not replaced.").waitFor();
  const replaceDraft = page.getByRole("button", { name: "Replace Local Draft with restored Server Save" });

  await page.evaluate(() => { window.__nuriteoRuntimeProbe.restoreMode = "intervening"; });
  await replaceDraft.click();
  await page.getByText(/Server Project changed before the restored Save could be promoted/u).waitFor();
  assert.equal(await editor.inputValue(), 'export const label = "newer local draft";\n');

  await page.evaluate(() => { window.__nuriteoRuntimeProbe.restoreMode = "download-failure"; });
  await replaceDraft.click();
  await page.getByText(/could not be fetched, verified, and materialized safely/u).waitFor();
  assert.equal(await editor.inputValue(), 'export const label = "newer local draft";\n');

  await page.evaluate(() => { window.__nuriteoRuntimeProbe.restoreMode = "materialization-failure"; });
  await replaceDraft.click();
  await page.getByText(/could not be fetched, verified, and materialized safely/u).waitFor();
  assert.equal(await editor.inputValue(), 'export const label = "newer local draft";\n');
  assert.equal(await page.evaluate(() => window.__nuriteoRuntimeProbe.activeWorkers), 2);

  await page.evaluate(() => { window.__nuriteoRuntimeProbe.restoreMode = "success"; });
  await replaceDraft.click();
  await page.getByText("Verified restored Server Save v3 is now the Local Draft.").waitFor();
  assert.equal(await editor.inputValue(), 'export const label = "restored exact head";\n');
  assert.equal(await editor.isEditable(), true);
  assert.equal(await page.evaluate(() => window.__nuriteoRuntimeProbe.activeWorkers), 2);

  await page.getByRole("button", { name: "Stop workspace" }).click();
  await page.getByRole("button", { name: "Start workspace from template", exact: true }).waitFor({ timeout: 10_000 });
  await page.waitForFunction(() => window.__nuriteoRuntimeProbe.activeWorkers === 0);
  assert.deepEqual(errors, []);
  console.log("WEB-007 browser Save matrix ok (retry, reconcile, 412, exact atomic restore, failure preservation, dispose)");
} finally {
  await browser.close();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  fs.rmSync(fixtureRoot, { force: true, recursive: true });
}

function contentType(file: string): string {
  if (file.endsWith(".html")) return "text/html; charset=utf-8";
  if (file.endsWith(".js") || file.endsWith(".mjs")) return "text/javascript; charset=utf-8";
  if (file.endsWith(".wasm")) return "application/wasm";
  if (file.endsWith(".json")) return "application/json; charset=utf-8";
  return "application/octet-stream";
}

async function requestJson(request: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

function problem(response: http.ServerResponse, status: number, code: string): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/problem+json");
  response.end(JSON.stringify({ type: "about:blank", title: "Rejected", status, detail: "Rejected.", instance: "/api/v1", code, request_id: "save-browser", errors: [] }));
}
