import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "@playwright/test";
import { build } from "esbuild";

declare global {
  interface Window { __nuriteoHistoryProbe: { committedEtag?: string; committedVersion?: number; reloads: number; resumes: number } }
}

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nuriteo-history-browser-"));
const ownerId = "0199ee6c-c777-7000-8000-00000000d001";
const projectId = "0199ee6c-c777-7000-8000-00000000d002";
const versionId = "0199ee6c-c777-7000-8000-00000000d011";
const nextVersionId = "0199ee6c-c777-7000-8000-00000000d012";
const recoveryId = "0199ee6c-c777-7000-8000-00000000d021";
const recoveryId2 = "0199ee6c-c777-7000-8000-00000000d022";
const bundleId = "0199ee6c-c777-7000-8000-00000000d031";
const userId = "0199ee6c-c777-7000-8000-00000000d041";
const operationId = "0199ee6c-c777-7000-8000-00000000d051";
const base = `/api/v1/workspaces/users/${ownerId}/projects/${projectId}`;
const csrf = `nrt_csrf_${"h".repeat(43)}`;
const requests: string[] = [];
const versionKeys: string[] = [];
let restoreAttempt = 0;

await build({
  bundle: true,
  entryPoints: [path.join(webRoot, "test/fixtures/project-history-journey.tsx")],
  format: "esm",
  jsx: "automatic",
  outfile: path.join(fixtureRoot, "fixture.js"),
  platform: "browser",
  target: "es2022"
});
fs.writeFileSync(path.join(fixtureRoot, "index.html"), '<!doctype html><meta charset="utf-8"><div id="root"></div><script type="module" src="/fixture.js"></script>\n');

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://fixture");
  if (url.pathname.startsWith(base)) {
    requests.push(`${request.method} ${url.pathname}${url.search}`);
    if (request.method !== "GET") assert.equal(request.headers["x-csrf-token"], csrf);
    if (request.method === "GET" && url.pathname === `${base}/versions`) {
      return json(response, { items: [version(versionId, "Before refactor", 1)], nextCursor: url.searchParams.has("cursor") ? null : "next-page" });
    }
    if (request.method === "GET" && url.pathname === `${base}/recovery-checkpoints`) {
      return json(response, { items: [recovery(recoveryId, 1, "2026-10-05T02:00:00.1Z"), recovery(recoveryId2, 2, "2026-10-05T02:00:00.100Z")] });
    }
    if (request.method === "POST" && url.pathname === `${base}/versions`) {
      assert.equal(request.headers["if-match"], '"project-v1"');
      assert.match(String(request.headers["idempotency-key"]), /^history-version-/u);
      versionKeys.push(String(request.headers["idempotency-key"]));
      const body = await bodyOf(request);
      if (body.name === "Stale Version") return problem(response, 412, "PROJECT_VERSION_STALE");
      return json(response, { idempotentRetry: false, version: version(nextVersionId, String(body.name), 1) }, 201);
    }
    if (request.method === "POST" && url.pathname === `${base}/history/restore`) {
      restoreAttempt += 1;
      assert.equal(request.headers["if-match"], '"project-v1"');
      assert.match(String(request.headers["idempotency-key"]), /^history-restore-/u);
      if (restoreAttempt === 1) return problem(response, 503, "COMMIT_OUTCOME_UNKNOWN");
      response.setHeader("etag", '"project-v3"');
      return json(response, promotion("recovery", recoveryId, 3));
    }
    if (request.method === "GET" && url.pathname === `${base}/history/restore`) {
      assert.match(String(request.headers["idempotency-key"]), /^history-restore-/u);
      response.setHeader("etag", '"project-v2"');
      return json(response, promotion("version", versionId, 2));
    }
    return problem(response, 404, "NOT_FOUND");
  }
  const file = path.join(fixtureRoot, url.pathname === "/" ? "index.html" : url.pathname.slice(1));
  if (!file.startsWith(fixtureRoot) || !fs.existsSync(file)) { response.writeHead(404).end(); return; }
  response.setHeader("content-type", file.endsWith(".js") ? "text/javascript" : "text/html");
  response.end(fs.readFileSync(file));
});

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert.ok(address && typeof address !== "string");
const origin = `http://127.0.0.1:${address.port}`;
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext();
  await context.addCookies([{ name: "nuriteo_dev_csrf", value: csrf, url: origin }]);
  const page = await context.newPage();
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(origin, { waitUntil: "networkidle" });
  await page.getByText("1 Versions and 2 Recovery checkpoints loaded.").waitFor();
  assert.equal(await page.getByRole("region", { name: "Recovery checkpoints" }).locator("li strong").first().textContent(), "Recovery 2");

  await page.getByRole("button", { name: "Load more Versions" }).click();
  await page.getByText("1 more Versions loaded.").waitFor();
  assert.match(requests.at(-1) ?? "", /cursor=next-page/u);

  await page.getByLabel("Version name").fill("Stale Version");
  await page.getByRole("button", { name: "Create Version" }).click();
  await page.getByText(/Server Project changed/u).waitFor();
  await page.getByRole("button", { name: "Reload latest Project" }).click();
  assert.equal(await page.evaluate(() => window.__nuriteoHistoryProbe.reloads), 1);

  await page.getByLabel("Version name").fill("Manual checkpoint");
  await page.getByRole("button", { name: "Create Version" }).click();
  await page.getByText("Version “Manual checkpoint” created.").waitFor();
  assert.notEqual(versionKeys[0], versionKeys[1], "a changed Version payload must use a fresh idempotency key");

  const beforeRefactor = page.locator("li", { hasText: "Before refactor" });
  await beforeRefactor.getByRole("button", { name: "Restore" }).click();
  const confirm = page.getByRole("button", { name: "Restore Server Working Head" });
  await confirm.waitFor();
  assert.equal(await confirm.evaluate((element) => element === document.activeElement), true);
  await page.keyboard.press("Shift+Tab");
  assert.equal(await page.getByRole("button", { name: "Cancel" }).evaluate((element) => element === document.activeElement), true);
  await page.keyboard.press("Tab");
  assert.equal(await confirm.evaluate((element) => element === document.activeElement), true);
  await page.keyboard.press("Escape");
  await confirm.waitFor({ state: "detached" });
  await page.waitForTimeout(50);
  assert.equal(await beforeRefactor.getByRole("button", { name: "Restore" }).evaluate((element) => element === document.activeElement), true);

  await beforeRefactor.getByRole("button", { name: "Restore" }).click();
  await page.getByRole("button", { name: "Restore Server Working Head" }).click();
  await page.getByText("Server Working Head is now v2. The browser Local Draft was not replaced.").waitFor();
  await page.getByText("Your current Local Draft is still open and unchanged.").waitFor();
  assert.deepEqual(await page.evaluate(() => ({
    etag: window.__nuriteoHistoryProbe.committedEtag,
    version: window.__nuriteoHistoryProbe.committedVersion
  })), { etag: '"project-v2"', version: 2 });
  assert.ok(requests.some((entry) => entry === `GET ${base}/history/restore`), "unknown restore must reconcile");

  await page.getByRole("button", { name: "Replace Local Draft with restored Server Save" }).click();
  assert.equal(await page.evaluate(() => window.__nuriteoHistoryProbe.resumes), 1);

  await page.getByRole("button", { name: "Archive fixture Project" }).click();
  await page.getByText("Archived · read-only").waitFor();
  assert.equal(await page.getByRole("button", { name: "Create Version" }).count(), 0);
  assert.equal(await page.getByRole("button", { name: "Restore", exact: true }).count(), 0);
  assert.equal(await page.getByText("Before refactor", { exact: true }).count(), 1);
  assert.deepEqual(pageErrors, []);
  console.log("WEB-007 browser history matrix ok (pagination, 412, create, focus/Escape, reconcile, Local Draft, archive)");
} finally {
  await browser.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
}

function version(id: string, name: string, sourceProjectVersion: number) {
  return { id, projectId, bundleId, name, createdByUserId: userId, sourceProjectVersion, createdAt: "2026-10-05T01:00:00Z", sha256: "a".repeat(64), physicalBytes: 2048, logicalBytes: 1024, fileCount: 4, format: "project-bundle-v1" };
}
function recovery(id: string, position: number, createdAt: string) { return { id, projectId, bundleId, position, createdByUserId: userId, createdAt, sha256: "b".repeat(64), physicalBytes: 1024, logicalBytes: 512, fileCount: 2, format: "project-bundle-v1" }; }
function promotion(referenceKind: "version" | "recovery", referenceId: string, projectVersion: number) { return { operationId, referenceKind, referenceId, bundleId, projectVersion, changed: true, idempotentRetry: false }; }
function json(response: http.ServerResponse, value: unknown, status = 200) { response.statusCode = status; response.setHeader("content-type", "application/json"); response.end(JSON.stringify(value)); }
function problem(response: http.ServerResponse, status: number, code: string) { response.statusCode = status; response.setHeader("content-type", "application/problem+json"); response.end(JSON.stringify({ type: "about:blank", title: "Rejected", status, detail: "Rejected.", instance: base, code, request_id: "history-browser", errors: [] })); }
async function bodyOf(request: http.IncomingMessage): Promise<Record<string, unknown>> { const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)); return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>; }
