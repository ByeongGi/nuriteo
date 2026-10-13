import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "@playwright/test";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const standaloneWeb = path.join(webRoot, ".next/standalone/apps/web");
const serverEntry = path.join(standaloneWeb, "server.js");
const csrfToken = `nrt_csrf_${"b".repeat(43)}`;
assert.ok(fs.existsSync(serverEntry), "Run the production build before this browser check.");
fs.cpSync(path.join(webRoot, ".next/static"), path.join(standaloneWeb, ".next/static"), { force: true, recursive: true });

let version = 1;
let pruneCandidates = 2;
const mutations: Array<{ body: unknown; csrf: string | undefined; etag: string | undefined }> = [];
const operations: Array<{ body: unknown; csrf: string | undefined }> = [];

const core = http.createServer(async (request, response) => {
  const requestPath = request.url ?? "/";
  const admin = request.headers.cookie?.includes("nuriteo_dev_session=admin") === true;
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-request-id", "admin-backups-browser");
  if (!admin) return sendProblem(response, 401, "AUTHENTICATION_REQUIRED");
  if (request.method === "GET" && requestPath === "/api/v1/me") return sendJson(response, currentUser());
  if (request.method === "GET" && requestPath === "/api/v1/mfa") return sendJson(response, { localAccount: true, enrolled: false, pendingEnrollment: false, recoveryCodesRemaining: 0, policyMode: "off", gracePeriodDays: 7, required: false, deadlineAt: null, restricted: false, notificationState: "none" });
  if (request.method === "GET" && requestPath === "/api/v1/notifications?limit=1") return sendJson(response, { items: [], nextCursor: null, unreadCount: 0 });
  if (request.method === "GET" && requestPath === "/api/v1/admin/backups") {
    response.setHeader("etag", `"backup-policy-v${version}"`);
    return sendJson(response, state());
  }
  if (request.method === "PUT" && requestPath === "/api/v1/admin/backups/policy") {
    const body = await jsonBody(request);
    mutations.push({ body, csrf: header(request, "x-csrf-token"), etag: header(request, "if-match") });
    if (header(request, "x-csrf-token") !== csrfToken) return sendProblem(response, 403, "CSRF_REJECTED");
    if (header(request, "if-match") !== `"backup-policy-v${version}"`) return sendProblem(response, 412, "POLICY_STALE");
    version += 1;
    response.setHeader("etag", `"backup-policy-v${version}"`);
    return sendJson(response, state());
  }
  if (request.method === "POST" && requestPath === "/api/v1/admin/backups/operations") {
    const body = await jsonBody(request);
    operations.push({ body, csrf: header(request, "x-csrf-token") });
    if (header(request, "x-csrf-token") !== csrfToken) return sendProblem(response, 403, "CSRF_REJECTED");
    pruneCandidates = 0;
    response.statusCode = 202;
    return sendJson(response, state());
  }
  response.statusCode = 404;
  response.end();
});

await listen(core);
const address = core.address();
assert.ok(address && typeof address !== "string");
const webPort = await reservePort();
const web = spawn(process.execPath, [serverEntry], {
  cwd: standaloneWeb,
  env: { ...process.env, HOSTNAME: "127.0.0.1", NURITEO_INTERNAL_API_URL: `http://127.0.0.1:${address.port}`, PORT: String(webPort) },
  stdio: ["ignore", "pipe", "pipe"]
});
let output = "";
for (const stream of [web.stdout, web.stderr]) stream.on("data", (chunk: Buffer) => { output = `${output}${chunk.toString("utf8")}`.slice(-4_000); });

try {
  const origin = `http://127.0.0.1:${webPort}`;
  await waitUntilReady(origin, web);
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.addCookies([
      { name: "nuriteo_dev_session", value: "admin", url: origin },
      { name: "nuriteo_dev_csrf", value: csrfToken, url: origin }
    ]);
    const page = await context.newPage();
    await page.goto(`${origin}/admin/backups`, { waitUntil: "networkidle" });
    await page.getByRole("heading", { level: 1, name: "Backups" }).waitFor();
    assert.equal(await page.getByText("No successful restore point is available yet.").count(), 1);
    assert.equal(await page.getByRole("button", { name: "Prune 2 eligible" }).isEnabled(), true);
    await page.getByLabel("Backup timezone").fill("Asia/Seoul");
    await page.getByRole("button", { name: "Save policy" }).click();
    await page.getByRole("status").filter({ hasText: "audit log" }).waitFor();
    assert.equal(mutations[0]?.etag, '"backup-policy-v1"');
    assert.equal(mutations[0]?.csrf, csrfToken);
    assert.equal((mutations[0]?.body as { scheduleTimezone?: string }).scheduleTimezone, "Asia/Seoul");
    await page.getByRole("button", { name: "Run recovery drill" }).click();
    await page.getByRole("status").filter({ hasText: "queued" }).waitFor();
    assert.deepEqual(operations[0]?.body, { kind: "drill", backupId: null });
    assert.equal(operations[0]?.csrf, csrfToken);
    const history = page.locator("section").filter({ has: page.getByRole("heading", { name: "Operation history" }) });
    assert.match(await history.innerText(), /Recovery drill.*queued/su);
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    await context.close();
  } finally {
    await browser.close();
  }
} catch (error) {
  throw new Error(`admin backups browser journey failed; server output: ${output}`, { cause: error });
} finally {
  await stopChild(web);
  await new Promise<void>((resolve) => core.close(() => resolve()));
}

function state() {
  return {
    policy: { enabled: true, intervalHours: 24, scheduleTime: "02:00", scheduleTimezone: "UTC", dailyRetention: 7, weeklyRetention: 4, monthlyRetention: 6, failedRetentionDays: 7, multipartCleanupHours: 24, warningAfterHours: 24, criticalAfterFailures: 3, drillFrequency: "monthly", drillTime: "03:00", drillTimezone: "UTC", version },
    restorePoints: [],
    operations: operations.length === 0 ? [] : [{ id: "0199ee6c-c777-7000-8000-000000030001", kind: "drill", source: "manual", backupId: null, state: "queued", failureCode: null, requestedAt: "2026-10-11T00:00:00Z", startedAt: null, completedAt: null }],
    alerts: [{ level: "warning", code: "no_restore_point", message: "No successful restore point is available yet." }],
    pruneCandidates
  };
}

function currentUser() {
  return { user: { id: "0199ee6c-c777-7000-8000-000000010001", email: "admin@example.test", display_name: "Instance Administrator", is_instance_admin: true }, session: { id: "0199ee6c-c777-7000-8000-000000010002", last_seen_at: "2026-10-11T00:00:00Z", idle_expires_at: "2026-10-11T01:00:00Z", absolute_expires_at: "2026-10-12T00:00:00Z" } };
}

function header(request: http.IncomingMessage, name: string) { const value = request.headers[name]; return Array.isArray(value) ? value[0] : value; }
async function jsonBody(request: http.IncomingMessage) { const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk)); return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
function sendJson(response: http.ServerResponse, value: unknown) { response.setHeader("content-type", "application/json"); response.end(JSON.stringify(value)); }
function sendProblem(response: http.ServerResponse, status: number, code: string) { response.statusCode = status; response.setHeader("content-type", "application/problem+json"); response.end(JSON.stringify({ type: "about:blank", title: "Rejected", status, detail: "Rejected", instance: "/api/v1/admin/backups", code, request_id: "admin-backups-browser", errors: [] })); }
async function listen(server: http.Server) { await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); }); }
async function reservePort() { const server = http.createServer(); await listen(server); const address = server.address(); assert.ok(address && typeof address !== "string"); const port = address.port; await new Promise<void>((resolve) => server.close(() => resolve())); return port; }
async function waitUntilReady(origin: string, child: ReturnType<typeof spawn>) { const deadline = Date.now() + 15_000; while (Date.now() < deadline) { if (child.exitCode !== null) throw new Error("web exited"); try { if ((await fetch(`${origin}/sign-in`, { redirect: "manual" })).status < 500) return; } catch {} await new Promise((resolve) => setTimeout(resolve, 100)); } throw new Error("web not ready"); }
async function stopChild(child: ReturnType<typeof spawn>) { if (child.exitCode !== null) return; child.kill("SIGTERM"); await new Promise<void>((resolve) => child.once("exit", () => resolve())); }

console.log("admin backup schedule, retention, drill, prune and audit browser journey ok");
