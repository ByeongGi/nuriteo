import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "@playwright/test";
import { build } from "esbuild";

declare global {
  interface Window { __nuriteoRuntimeProbe: { activeWorkers: number; createdWorkers: number; committedVersion?: number; committedEtag?: string } }
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
const saveRequests: string[] = [];
const server = http.createServer(async (request, response) => {
  response.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
  if (pathname.includes("/save-sessions")) {
    saveRequests.push(`${request.method} ${pathname}`);
    assert.equal(request.headers["x-csrf-token"], csrf);
    if (pathname.endsWith("/save-sessions") && request.method === "POST") {
      assert.equal(request.headers["if-match"], '"project-v1"');
      assert.match(String(request.headers["idempotency-key"]), /^bundle-v1-[0-9a-f]{64}$/u);
      const body = await requestJson(request);
      response.statusCode = 201;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        expiresAt: "2026-10-04T12:00:00Z", idempotentRetry: false, partCount: 1,
        sessionId: saveSessionId, uploadMode: "single", upload: {
          method: "PUT", url: "https://storage.test/runtime-save", expectedBytes: body.physicalBytes,
          headers: [{ name: "x-amz-checksum-sha256", value: body.sha256 }]
        }
      }));
      return;
    }
    if (pathname.endsWith(`/${saveSessionId}/complete`) && request.method === "POST") {
      response.setHeader("content-type", "application/json");
      response.setHeader("etag", '"project-v2"');
      response.end(JSON.stringify({ bundleId, projectVersion: 2 }));
      return;
    }
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

  await page.getByRole("button", { name: "Start workspace" }).click();
  await page.getByRole("button", { name: "Run Preview" }).waitFor({ timeout: 20_000 });
  assert.equal(await page.evaluate(() => window.__nuriteoRuntimeProbe.createdWorkers), 2);

  await page.getByRole("button", { name: "src/message.ts" }).click();
  const editor = page.getByLabel("Editor for src/message.ts");
  await editor.fill('export const label = "RT004 edited";\n');
  await page.getByRole("button", { name: "Apply to Local Draft" }).click();
  await page.getByText("Local Draft saved", { exact: false }).waitFor({ timeout: 10_000 });
  await page.getByRole("button", { name: "Save to server" }).click();
  await page.getByText("Server Save v2 complete · Local Draft is current", { exact: true }).waitFor({ timeout: 20_000 });
  assert.deepEqual(await page.evaluate(() => ({
    etag: window.__nuriteoRuntimeProbe.committedEtag,
    version: window.__nuriteoRuntimeProbe.committedVersion
  })), { etag: '"project-v2"', version: 2 });
  assert.deepEqual(saveRequests.map((entry) => entry.split(" ")[0]), ["POST", "POST"]);
  assert.match(saveRequests[1] ?? "", /\/complete$/u);

  await page.getByRole("button", { name: "Stop workspace" }).click();
  await page.getByRole("button", { name: "Start workspace" }).waitFor({ timeout: 10_000 });
  await page.waitForFunction(() => window.__nuriteoRuntimeProbe.activeWorkers === 0);
  assert.deepEqual(errors, []);
  console.log("WEB-006 actual browser Save journey ok (Runtime edit, canonical upload, commit ETag, dispose)");
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
