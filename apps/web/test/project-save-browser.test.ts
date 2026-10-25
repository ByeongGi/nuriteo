import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "@playwright/test";
import { build } from "esbuild";

import type { RuntimeAdapter } from "../src/runtime/runtime-adapter.ts";

declare global {
  interface Window { __nuriteoRuntimeProbe: { activeWorkers: number; adapter?: RuntimeAdapter; createdWorkers: number; committedVersion?: number; committedEtag?: string; reloads: number; restoreMode: "download-failure" | "intervening" | "materialization-failure" | "not-saved" | "success"; runtimeActiveWorkers: number; runtimeCreatedWorkers: number } }
}

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicRoot = path.join(webRoot, "public");
const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nuriteo-runtime-browser-"));
await build({
  bundle: true,
  entryPoints: [path.join(webRoot, "test/fixtures/runtime-journey.tsx")],
  format: "esm",
  jsx: "automatic",
  loader: { ".ttf": "dataurl" },
  outfile: path.join(fixtureRoot, "fixture.js"),
  platform: "browser",
  target: "es2022"
});
fs.writeFileSync(path.join(fixtureRoot, "index.html"), '<!doctype html><meta charset="utf-8"><div id="root"></div><script type="module" src="/fixture.js"></script>\n');

const csrf = `nrt_csrf_${"s".repeat(43)}`;
const saveSessionId = "0199ee6c-c777-7000-8000-00000000b003";
const bundleId = "0199ee6c-c777-7000-8000-00000000b004";
const saveRequests: string[] = [];
let createAttempts = 0;
const server = http.createServer(async (request, response) => {
  response.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
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
  const root = pathname.startsWith("/runtime/")
    ? publicRoot
    : pathname.startsWith("/node_modules/monaco-editor/")
      ? webRoot
      : fixtureRoot;
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

  await page.getByRole("button", { name: "미리보기 실행" }).waitFor({ timeout: 20_000 });
  assert.equal(await page.evaluate(() => window.__nuriteoRuntimeProbe.runtimeCreatedWorkers), 2);

  await page.getByTitle("src/message.ts").click();
  const editor = page.getByLabel("src/message.ts 편집기");
  await replaceEditorValue(page, "src/message.ts 편집기", 'export const label = "RT004 edited";\n');
  await clickButton(page, "로컬 초안에 적용");
  await page.getByText("로컬 초안 저장됨", { exact: false }).waitFor({ timeout: 10_000 });
  await clickButton(page, "서버에 저장");
  await page.getByText("서버 저장 실패 · 로컬 초안 보존됨", { exact: true }).waitFor({ timeout: 20_000 });
  await clickButton(page, "서버 저장 다시 시도");
  await page.getByText("서버 저장 v2 완료 · 로컬 초안과 일치", { exact: true }).waitFor({ timeout: 20_000 });
  assert.deepEqual(await page.evaluate(() => ({
    etag: window.__nuriteoRuntimeProbe.committedEtag,
    version: window.__nuriteoRuntimeProbe.committedVersion
  })), { etag: '"project-v2"', version: 2 });
  assert.ok(saveRequests.some((entry) => entry.endsWith("/reconcile")), "unknown Save completion must reconcile");

  await replaceEditorValue(page, "src/message.ts 편집기", 'export const label = "newer local draft";\n');
  await clickButton(page, "로컬 초안에 적용");
  await clickButton(page, "서버에 저장");
  await page.getByText(/저장 전에 서버 프로젝트가 변경되었습니다/u).waitFor({ timeout: 20_000 });
  await clickButton(page, "최신 프로젝트 다시 불러오기");
  assert.equal(await page.evaluate(() => window.__nuriteoRuntimeProbe.reloads), 1);
  assert.equal(await workspaceText(page, "src/message.ts"), 'export const label = "newer local draft";\n');
  assert.equal(await page.evaluate(() => window.__nuriteoRuntimeProbe.runtimeActiveWorkers), 2);
  assert.notEqual(await editor.getAttribute("aria-readonly"), "true");

  await clickButton(page, "워크스페이스 종료");
  const discardDraft = page.getByRole("button", { name: "초안을 버리고 종료" });
  await discardDraft.waitFor();
  await discardDraft.evaluate((button: HTMLButtonElement) => button.click());
  try {
    await page.getByRole("button", { name: "Studio 열기", exact: true }).waitFor({ timeout: 10_000 });
  } catch (error) {
    const cleanupState = await page.evaluate(() => ({
      activeWorkers: window.__nuriteoRuntimeProbe.activeWorkers,
      lifecycle: window.__nuriteoRuntimeProbe.adapter?.getState().lifecycle,
      text: document.body.innerText
    }));
    throw new Error(`Studio did not dispose cleanly: ${JSON.stringify(cleanupState)}`, { cause: error });
  }
  await page.waitForFunction(() => window.__nuriteoRuntimeProbe.runtimeActiveWorkers === 0);
  assert.deepEqual(errors, []);
  console.log("WEB-007 browser Save matrix ok (retry, reconcile, 412, local draft preservation, dispose)");
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

async function replaceEditorValue(
  page: import("@playwright/test").Page,
  label: string,
  value: string
): Promise<void> {
  const editor = page.getByLabel(label);
  await editor.press("ControlOrMeta+A");
  await editor.pressSequentially(value, { delay: 1 });
  await page.getByText(new RegExp(`${value.length}자`, "u")).waitFor();
}

async function workspaceText(page: import("@playwright/test").Page, path: string): Promise<string | undefined> {
  return page.evaluate((filePath) => window.__nuriteoRuntimeProbe.adapter?.workspace.readText(filePath), path);
}

async function clickButton(page: import("@playwright/test").Page, name: string): Promise<void> {
  // This isolated fixture omits the production Tailwind positioning stylesheet.
  await page.getByRole("button", { name, exact: true }).evaluate((button: HTMLButtonElement) => button.click());
}

function problem(response: http.ServerResponse, status: number, code: string): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/problem+json");
  response.end(JSON.stringify({ type: "about:blank", title: "Rejected", status, detail: "Rejected.", instance: "/api/v1", code, request_id: "save-browser", errors: [] }));
}
