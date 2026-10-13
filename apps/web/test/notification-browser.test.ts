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
const csrf = `nrt_csrf_${"n".repeat(43)}`;
const notificationId = "0199ee6c-c777-7000-8000-000000030001";
const additionalNotificationId = "0199ee6c-c777-7000-8000-000000030005";
const deadId = "0199ee6c-c777-7000-8000-000000030002";
const pendingId = "0199ee6c-c777-7000-8000-000000030003";
const sendingId = "0199ee6c-c777-7000-8000-000000030006";
let notification = notificationView("unread", 1);
const additionalNotification = {
  ...notificationView("read", 1),
  id: additionalNotificationId,
  classification: "operations",
  eventCode: "operations.delivery.delayed",
  title: "Operations notification",
  summary: "Review this instance operations event."
};
let preferences = preferenceView(false, 1);
const mutations: Array<{ readonly path: string; readonly csrf: string | undefined; readonly etag: string | undefined; readonly idempotency: string | undefined; readonly origin: string | undefined }> = [];

assert.ok(fs.existsSync(serverEntry), "Run the production build before this browser check.");
fs.cpSync(path.join(webRoot, ".next/static"), path.join(standaloneWeb, ".next/static"), { force: true, recursive: true });

const core = http.createServer(async (request, response) => {
  const requestPath = request.url ?? "/";
  const session = request.headers.cookie?.includes("nuriteo_dev_session=admin") ? "admin" : "user";
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-request-id", "notification-browser");
  if (!request.headers.cookie?.includes("nuriteo_dev_session=")) return problem(response, 401, "AUTHENTICATION_REQUIRED");
  if (request.method === "GET" && requestPath === "/api/v1/me") return json(response, currentUser(session));
  if (request.method === "GET" && requestPath === "/api/v1/mfa") return json(response, mfaStatus());
  if (request.method === "GET" && requestPath.startsWith("/api/v1/notifications")) {
    const query = new URL(requestPath, "http://core").searchParams;
    const archived = query.get("archived") === "true";
    if (!archived && query.get("cursor") === "next-page") {
      return json(response, { items: [notification, additionalNotification], nextCursor: null, unreadCount: notification.status === "unread" ? 1 : 0 });
    }
    const included = archived === (notification.status === "archived");
    return json(response, {
      items: included ? [notification] : [],
      nextCursor: !archived && included ? "next-page" : null,
      unreadCount: notification.status === "unread" ? 1 : 0
    });
  }
  if (request.method === "GET" && requestPath === "/api/v1/notification-preferences") return json(response, preferences);
  if (request.method === "GET" && requestPath.startsWith("/api/v1/admin/email-deliveries")) {
    const state = new URL(requestPath, "http://core").searchParams.get("state") ?? "dead_letter";
    const items = state === "dead_letter" ? [delivery(deadId, "dead_letter", 4)] : state === "pending" ? [delivery(pendingId, "pending", 1)] : state === "sending" ? [delivery(sendingId, "sending", 2)] : [];
    return json(response, { items, nextCursor: null, smtpConfigured: false });
  }

  mutations.push({
    path: requestPath,
    csrf: header(request, "x-csrf-token"),
    etag: header(request, "if-match"),
    idempotency: header(request, "idempotency-key"),
    origin: header(request, "origin")
  });
  if (header(request, "x-csrf-token") !== csrf) return problem(response, 403, "CSRF_REJECTED");
  if (request.method === "PATCH" && requestPath === `/api/v1/notifications/${notificationId}`) {
    if (header(request, "if-match") !== `"notification-v${notification.version}"`) return problem(response, 412, "PRECONDITION_FAILED");
    const body = await bodyOf(request);
    notification = notificationView(String(body.status), notification.version + 1);
    response.setHeader("etag", `"notification-v${notification.version}"`);
    return json(response, notification);
  }
  if (request.method === "PATCH" && requestPath === "/api/v1/notification-preferences") {
    if (header(request, "if-match") !== `"notification-preferences-v${preferences.version}"`) return problem(response, 412, "PRECONDITION_FAILED");
    const body = await bodyOf(request);
    preferences = { ...preferenceView(Boolean(body.collaboration), preferences.version + 1), accountAccess: Boolean(body.accountAccess), operations: Boolean(body.operations) };
    response.setHeader("etag", `"notification-preferences-v${preferences.version}"`);
    return json(response, preferences);
  }
  if (request.method === "POST" && requestPath === `/api/v1/admin/email-deliveries/${deadId}/retry`) {
    assert.equal(header(request, "if-match"), '"email-delivery-v4"');
    assert.match(header(request, "idempotency-key") ?? "", /^notification-retry-/u);
    response.setHeader("etag", '"email-delivery-v1"');
    return json(response, delivery("0199ee6c-c777-7000-8000-000000030004", "pending", 1));
  }
  if (request.method === "POST" && requestPath === `/api/v1/admin/email-deliveries/${pendingId}/cancel`) {
    assert.equal(header(request, "if-match"), '"email-delivery-v1"');
    response.setHeader("etag", '"email-delivery-v2"');
    return json(response, delivery(pendingId, "canceled", 2));
  }
  response.statusCode = 404;
  response.end();
});

await listen(core);
const coreAddress = core.address();
assert.ok(coreAddress && typeof coreAddress !== "string");
const webPort = await reservePort();
const web = spawn(process.execPath, [serverEntry], {
  cwd: standaloneWeb,
  env: { ...process.env, HOSTNAME: "127.0.0.1", NURITEO_INTERNAL_API_URL: `http://127.0.0.1:${coreAddress.port}`, PORT: String(webPort) },
  stdio: ["ignore", "pipe", "pipe"]
});
let output = "";
for (const stream of [web.stdout, web.stderr]) stream.on("data", (chunk: Buffer) => { output = `${output}${chunk.toString("utf8")}`.slice(-4_000); });

try {
  const origin = `http://127.0.0.1:${webPort}`;
  await ready(origin);
  const browser = await chromium.launch({ headless: true });
  try {
    const user = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await user.addCookies([{ name: "nuriteo_dev_session", value: "user", url: origin }, { name: "nuriteo_dev_csrf", value: csrf, url: origin }]);
    const page = await user.newPage();
    await page.goto(`${origin}/notifications`, { waitUntil: "networkidle" });
    await page.getByRole("heading", { level: 1, name: "Notifications" }).waitFor();
    assert.equal(await page.getByLabel("1 unread notifications").count(), 1);
    const loadMore = page.getByRole("button", { name: "Load more" });
    await loadMore.focus();
    assert.equal(await loadMore.evaluate((element) => element === document.activeElement), true);
    await loadMore.press("Enter");
    await page.getByText("Operations notification").waitFor();
    assert.equal(await page.getByText("Account access updated").count(), 1);
    const primaryNotification = page.getByRole("listitem").filter({ hasText: "Account access updated" });
    await primaryNotification.getByRole("button", { name: "Mark read" }).click();
    await primaryNotification.getByRole("button", { name: "Mark unread" }).waitFor();
    notification = notificationView("read", 3);
    await primaryNotification.getByRole("button", { name: "Mark unread" }).click();
    await page.getByRole("alert").filter({ hasText: "changed elsewhere" }).waitFor();
    await page.reload({ waitUntil: "networkidle" });
    await page.getByRole("button", { name: "Archive" }).click();
    await page.getByRole("tab", { name: "Archived" }).click();
    await page.getByRole("button", { name: "Restore" }).waitFor();
    await page.getByLabel("Collaboration").check();
    await page.getByRole("button", { name: "Save preferences" }).click();
    await page.getByRole("status").filter({ hasText: "saved" }).waitFor();
    assert.equal(await page.getByText(/SMTP is not configured/u).count(), 1);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);

    const admin = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await admin.addCookies([{ name: "nuriteo_dev_session", value: "admin", url: origin }, { name: "nuriteo_dev_csrf", value: csrf, url: origin }]);
    const adminPage = await admin.newPage();
    await adminPage.goto(`${origin}/admin/notifications`, { waitUntil: "networkidle" });
    await adminPage.getByRole("heading", { level: 1, name: "Email delivery" }).waitFor();
    assert.equal(await adminPage.getByRole("status").filter({ hasText: "SMTP unavailable" }).count(), 1);
    const retry = adminPage.getByRole("button", { name: "Retry now" });
    await retry.focus();
    assert.equal(await retry.evaluate((element) => element === document.activeElement), true);
    await retry.press("Enter");
    await adminPage.getByRole("alert").filter({ hasText: "recent administrator" }).waitFor();
    await adminPage.getByRole("button", { name: "Confirm retry" }).click();
    await adminPage.getByRole("status").filter({ hasText: "new pending delivery" }).waitFor();
    await adminPage.getByLabel("State").selectOption("pending");
    await adminPage.getByRole("button", { name: "Discard" }).click();
    await adminPage.getByRole("button", { name: "Confirm discard" }).click();
    await adminPage.getByRole("status").filter({ hasText: "discarded" }).waitFor();
    await adminPage.getByLabel("State").selectOption("sending");
    await adminPage.getByText("sending", { exact: true }).waitFor();
    assert.equal(await adminPage.getByRole("button", { name: /Discard/u }).count(), 0);
    assert.equal(await adminPage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    assert.ok(mutations.every((entry) => entry.csrf === csrf && entry.origin === origin));
    assert.ok(mutations.filter((entry) => entry.path.includes("email-deliveries")).every((entry) => entry.idempotency !== undefined));
    await Promise.all([user.close(), admin.close()]);
  } finally {
    await browser.close();
  }
} catch (error) {
  throw new Error(`Notification browser journey failed; server output: ${output}`, { cause: error });
} finally {
  await stop(web);
  await new Promise<void>((resolve) => core.close(() => resolve()));
}

console.log("web notification inbox, preferences, and delivery admin journey ok");

function notificationView(status: string, version: number) { return { id: notificationId, classification: "account_access", eventCode: "identity.password.changed", title: "Account access updated", summary: "Review this account or access change.", status, actionState: "none", occurrenceCount: 1, occurredAt: "2026-10-08T00:00:00Z", version }; }
function preferenceView(collaboration: boolean, version: number) { return { criticalSecurity: true, accountAccess: true, collaboration, operations: false, smtpConfigured: false, version }; }
function delivery(id: string, state: string, version: number) { return { id, recipientEmail: "user@example.test", classification: "account_access", templateId: "identity.password_changed", resourceType: "user", resourceId: notificationId, state, attemptCount: state === "dead_letter" ? 8 : 0, smtpCode: state === "dead_letter" ? 550 : null, errorClass: state === "dead_letter" ? "permanent" : null, availableAt: "2026-10-08T00:00:00Z", updatedAt: "2026-10-08T01:00:00Z", version }; }
function currentUser(session: "admin" | "user") { const admin = session === "admin"; return { user: { id: admin ? "0199ee6c-c777-7000-8000-000000030011" : "0199ee6c-c777-7000-8000-000000030012", email: admin ? "admin@example.test" : "user@example.test", display_name: admin ? "Notification Administrator" : "Notification User", is_instance_admin: admin }, session: { id: admin ? "0199ee6c-c777-7000-8000-000000030021" : "0199ee6c-c777-7000-8000-000000030022", last_seen_at: "2026-10-08T00:00:00Z", idle_expires_at: "2026-10-08T01:00:00Z", absolute_expires_at: "2026-10-09T00:00:00Z" } }; }
function mfaStatus() { return { localAccount: true, enrolled: true, pendingEnrollment: false, recoveryCodesRemaining: 8, policyMode: "off", gracePeriodDays: 7, required: false, deadlineAt: null, restricted: false, notificationState: "none" }; }
function header(request: http.IncomingMessage, name: string): string | undefined { const value = request.headers[name]; return Array.isArray(value) ? value[0] : value; }
async function bodyOf(request: http.IncomingMessage): Promise<Record<string, unknown>> { const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk)); return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>; }
function json(response: http.ServerResponse, value: unknown): void { response.statusCode = 200; response.setHeader("content-type", "application/json"); response.end(JSON.stringify(value)); }
function problem(response: http.ServerResponse, status: number, code: string): void { response.statusCode = status; response.setHeader("content-type", "application/problem+json"); response.end(JSON.stringify({ type: "about:blank", title: "Rejected", status, detail: "Request rejected", instance: "/api/v1/notifications", code, request_id: "notification-browser", errors: [] })); }
async function listen(server: http.Server): Promise<void> { await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); }); }
async function reservePort(): Promise<number> { const server = http.createServer(); await listen(server); const address = server.address(); assert.ok(address && typeof address !== "string"); await new Promise<void>((resolve) => server.close(() => resolve())); return address.port; }
async function ready(origin: string): Promise<void> { const deadline = Date.now() + 15_000; while (Date.now() < deadline) { if (web.exitCode !== null) throw new Error("standalone server exited"); try { if ((await fetch(`${origin}/sign-in`)).status < 500) return; } catch {} await new Promise((resolve) => setTimeout(resolve, 100)); } throw new Error("standalone server not ready"); }
async function stop(child: ReturnType<typeof spawn>): Promise<void> { if (child.exitCode !== null) return; child.kill("SIGTERM"); await Promise.race([new Promise((resolve) => child.once("exit", resolve)), new Promise((resolve) => setTimeout(resolve, 2_000))]); if (child.exitCode === null) child.kill("SIGKILL"); }
