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
const csrf = `nrt_csrf_${"m".repeat(43)}`;
const manualSecret = "JBSWY3DPEHPK3PXP";
let userEnrolled = false;
let policy = { mode: "off", gracePeriodDays: 7, version: 1 };
let confirmResponseLost = false;
let confirmReceiptKey: string | undefined;
let populationRevision = 1;
const confirmRetrySessions: string[] = [];
const mutations: Array<{ path: string; url: string; csrf: string | undefined; etag: string | undefined; idempotency: string | undefined; origin: string | undefined }> = [];

assert.ok(fs.existsSync(serverEntry), "Run the production build before this browser check.");
fs.cpSync(path.join(webRoot, ".next/static"), path.join(standaloneWeb, ".next/static"), { force: true, recursive: true });

const core = http.createServer(async (request, response) => {
  const requestPath = request.url ?? "/";
  const session = sessionFrom(request.headers.cookie);
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-request-id", "mfa-browser");
  if (session === undefined) return problem(response, 401, "AUTHENTICATION_REQUIRED");
  if (request.method === "GET" && requestPath === "/api/v1/me") return json(response, currentUser(session));
  if (request.method === "GET" && requestPath === "/api/v1/me/workspaces") return json(response, { workspaces: [] });
  if (request.method === "GET" && requestPath === "/api/v1/mfa" && session === "statusfail") return problem(response, 503, "MFA_STATUS_UNAVAILABLE");
  if (request.method === "GET" && requestPath === "/api/v1/mfa") return json(response, status(session));
  if (request.method === "GET" && requestPath === "/api/v1/admin/mfa-policy") return json(response, policyView());
  if (request.method === "GET" && requestPath.startsWith("/api/v1/admin/mfa-reset-targets?")) return json(response, { items: [{ userId: "0199ee6c-c777-7000-8000-000000020002", email: "user@example.test", displayName: "MFA User", credentialGeneration: "0199ee6c-c777-7000-8000-000000020003" }] });

  if (request.method !== "GET") {
    mutations.push({
      path: requestPath,
      url: `http://core${requestPath}`,
      csrf: header(request, "x-csrf-token"),
      etag: header(request, "if-match"),
      idempotency: header(request, "idempotency-key"),
      origin: header(request, "origin")
    });
    if (header(request, "x-csrf-token") !== csrf) return problem(response, 403, "CSRF_REJECTED");
  }
  if (request.method === "POST" && requestPath === "/api/v1/mfa/enrollment") {
    return json(response, { credentialId: "0199ee6c-c777-7000-8000-000000020003", manualSecret, provisioningUri: `otpauth://totp/NURITEO%3Auser?secret=${manualSecret}&issuer=NURITEO` });
  }
  if (request.method === "POST" && requestPath === "/api/v1/mfa/enrollment/confirm") {
    const body = await bodyOf(request);
    if (body.code !== "123456") return problem(response, 401, "MFA_CHALLENGE_FAILED");
    userEnrolled = true;
    const key = header(request, "idempotency-key");
    if (!confirmResponseLost) {
      confirmResponseLost = true;
      confirmReceiptKey = key;
      response.destroy();
      return;
    }
    assert.equal(key, confirmReceiptKey);
    confirmRetrySessions.push(sessionCookieValue(request.headers.cookie) ?? "missing");
    response.setHeader("set-cookie", "nuriteo_dev_session=user-rotated; HttpOnly; SameSite=Strict; Path=/");
    return json(response, { recoveryCodes: ["AAAA-BBBB-CCCC", "DDDD-EEEE-FFFF"] });
  }
  if (request.method === "POST" && requestPath === "/api/v1/mfa/challenge") {
    response.statusCode = 204;
    response.setHeader("set-cookie", "nuriteo_dev_session=user-verified; HttpOnly; SameSite=Strict; Path=/");
    return response.end();
  }
  if (request.method === "PATCH" && requestPath === "/api/v1/admin/mfa-policy") {
    if (header(request, "if-match") !== `"mfa-policy-v${policy.version}"`) return problem(response, 412, "MFA_POLICY_STALE");
    const body = await bodyOf(request);
    if (body.populationProof !== populationProof()) return problem(response, 412, "MFA_POLICY_POPULATION_STALE");
    policy = { mode: String(body.mode), gracePeriodDays: Number(body.gracePeriodDays), version: policy.version + 1 };
    response.setHeader("etag", `"mfa-policy-v${policy.version}"`);
    return json(response, policyView());
  }
  if (request.method === "POST" && requestPath === "/api/v1/admin/mfa-policy/preview") {
    if (header(request, "if-match") !== `"mfa-policy-v${policy.version}"`) return problem(response, 412, "MFA_POLICY_STALE");
    const body = await bodyOf(request);
    return json(response, { mode: body.mode, gracePeriodDays: body.gracePeriodDays, policyVersion: policy.version, affectedUsers: body.mode === "off" ? 0 : 2, unenrolledUsers: 1, immediatelyRestrictedUsers: body.gracePeriodDays === 0 ? 1 : 0, enrolledLocalAdministrators: 1, populationProof: populationProof() });
  }
  if (request.method === "POST" && requestPath.endsWith("/mfa/reset")) {
    const body = await bodyOf(request);
    assert.equal(body.credentialGeneration, "0199ee6c-c777-7000-8000-000000020003");
    assert.equal(body.confirmation, "user@example.test");
    response.statusCode = 204;
    return response.end();
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
    const user = await browser.newContext({ viewport: { width: 390, height: 844 }, permissions: ["clipboard-read", "clipboard-write"] });
    await user.addCookies([{ name: "nuriteo_dev_session", value: "user", url: origin }, { name: "nuriteo_dev_csrf", value: csrf, url: origin }]);
    const page = await user.newPage();
    await page.goto(`${origin}/workspaces`, { waitUntil: "networkidle" });
    assert.equal(new URL(page.url()).pathname, "/mfa");
    await page.getByRole("heading", { name: "Multi-factor authentication" }).waitFor();
    assert.equal(await page.getByRole("alert").filter({ hasText: "Enrollment is required" }).count(), 1);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    await page.getByRole("button", { name: "Start enrollment" }).click();
    await page.getByRole("img", { name: "Authenticator provisioning QR code" }).waitFor();
    assert.equal(await page.getByText(manualSecret, { exact: true }).count(), 1);
    await page.getByLabel("Six-digit code").fill("123456");
    await page.getByRole("button", { name: "Verify and enable" }).click();
    await page.getByRole("alert").filter({ hasText: "may have committed" }).waitFor();
    await page.getByRole("button", { name: "Verify and enable" }).click();
    const saved = page.getByRole("button", { name: "Copy codes to continue" });
    await saved.waitFor();
    assert.equal(await saved.isDisabled(), true);
    await page.getByRole("button", { name: "Copy all codes" }).click();
    await page.getByRole("button", { name: "I saved the codes" }).click();
    await page.getByRole("heading", { name: "Authenticator challenge" }).waitFor();
    await page.getByLabel("Six-digit code").fill("654321");
    await page.getByRole("button", { name: "Verify code" }).click();
    await page.getByRole("status").filter({ hasText: "session was rotated" }).waitFor();
    assert.deepEqual(confirmRetrySessions, ["user"]);
    assert.ok(mutations.every((entry) => entry.csrf === csrf && entry.origin === origin));
    assert.ok(mutations.filter((entry) => entry.path.startsWith("/api/v1/mfa/")).every((entry) => entry.idempotency !== undefined));
    assert.ok(mutations.every((entry) => !entry.url.includes(manualSecret) && !entry.url.includes("otpauth")));

    userEnrolled = false;
    confirmResponseLost = false;
    confirmReceiptKey = undefined;
    const rotatedLoss = await browser.newContext({ viewport: { width: 800, height: 760 }, permissions: ["clipboard-read", "clipboard-write"] });
    await rotatedLoss.addCookies([{ name: "nuriteo_dev_session", value: "user", url: origin }, { name: "nuriteo_dev_csrf", value: csrf, url: origin }]);
    const rotatedLossPage = await rotatedLoss.newPage();
    await rotatedLossPage.goto(`${origin}/workspaces`, { waitUntil: "networkidle" });
    await rotatedLossPage.getByRole("button", { name: "Start enrollment" }).click();
    await rotatedLossPage.getByLabel("Six-digit code").fill("123456");
    await rotatedLossPage.getByRole("button", { name: "Verify and enable" }).click();
    await rotatedLossPage.getByRole("alert").filter({ hasText: "may have committed" }).waitFor();
    await rotatedLoss.addCookies([{ name: "nuriteo_dev_session", value: "user-rotated", url: origin }]);
    await rotatedLossPage.getByRole("button", { name: "Verify and enable" }).click();
    await rotatedLossPage.getByRole("button", { name: "Copy all codes" }).waitFor();
    assert.deepEqual(confirmRetrySessions, ["user", "user-rotated"]);

    const admin = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await admin.addCookies([{ name: "nuriteo_dev_session", value: "admin", url: origin }, { name: "nuriteo_dev_csrf", value: csrf, url: origin }]);
    const adminPage = await admin.newPage();
    await adminPage.goto(`${origin}/admin/mfa`, { waitUntil: "networkidle" });
    await adminPage.getByRole("heading", { level: 1, name: "MFA policy" }).waitFor();
    await adminPage.getByRole("radio", { name: /Administrators/u }).check();
    await adminPage.getByLabel("Grace period").fill("0");
    await adminPage.getByRole("button", { name: "Review impact" }).click();
    await adminPage.getByText("2", { exact: true }).first().waitFor();
    await adminPage.getByRole("button", { name: "Apply policy" }).click();
    await adminPage.getByRole("status").filter({ hasText: "reconciled" }).waitFor();
    const successfulPolicy = mutations.find((entry) => entry.path === "/api/v1/admin/mfa-policy");
    assert.equal(successfulPolicy?.etag, '"mfa-policy-v1"');

    await adminPage.getByRole("radio", { name: /All local users/u }).check();
    await adminPage.getByRole("button", { name: "Review impact" }).click();
    const applyPolicy = adminPage.getByRole("button", { name: "Apply policy" });
    await adminPage.waitForFunction(() => {
      const button = [...document.querySelectorAll("button")].find((candidate) => candidate.textContent === "Apply policy");
      return button instanceof HTMLButtonElement && !button.disabled;
    });
    populationRevision += 1;
    await applyPolicy.click();
    await adminPage.getByRole("alert").filter({ hasText: "Reload" }).waitFor();
    assert.equal(await adminPage.getByRole("button", { name: "Reload latest" }).count(), 1);
    assert.equal(await applyPolicy.isDisabled(), true);
    await adminPage.setViewportSize({ width: 390, height: 844 });
    assert.equal(await adminPage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    await adminPage.getByLabel("Find by email or display name").fill("user@example.test");
    await adminPage.getByRole("button", { name: "Search users" }).click();
    await adminPage.getByRole("radio", { name: /MFA User/u }).check();
    await adminPage.getByRole("checkbox", { name: /I understand/u }).check();
    await adminPage.getByRole("button", { name: "Reset MFA and sessions" }).click();
    await adminPage.getByRole("status").filter({ hasText: "sessions were reset" }).waitFor();

    const unavailable = await browser.newContext({ viewport: { width: 800, height: 700 } });
    await unavailable.addCookies([{ name: "nuriteo_dev_session", value: "statusfail", url: origin }]);
    const unavailablePage = await unavailable.newPage();
    await unavailablePage.goto(`${origin}/workspaces`, { waitUntil: "networkidle" });
    await unavailablePage.getByRole("heading", { name: "Your workspace is temporarily unavailable" }).waitFor();
    assert.equal(await unavailablePage.getByText("Workspaces", { exact: true }).count(), 0);
    await Promise.all([user.close(), rotatedLoss.close(), admin.close(), unavailable.close()]);
  } finally {
    await browser.close();
  }
} catch (error) {
  throw new Error(`MFA browser journey failed; server output: ${output}`, { cause: error });
} finally {
  await stop(web);
  await new Promise<void>((resolve) => core.close(() => resolve()));
}

console.log("web MFA self-service and policy journey ok");

function status(session: "user" | "admin" | "statusfail") {
  const enrolled = session === "admin" || userEnrolled;
  return { localAccount: true, enrolled, pendingEnrollment: false, recoveryCodesRemaining: enrolled ? 8 : 0, policyMode: session === "user" ? "all_local_users" : policy.mode, gracePeriodDays: session === "user" ? 0 : policy.gracePeriodDays, required: session === "user" && !enrolled, deadlineAt: session === "user" && !enrolled ? "2026-10-08T00:00:00Z" : null, restricted: session === "user" && !enrolled, notificationState: session === "user" && !enrolled ? "overdue" : "none" };
}
function policyView() { return { ...policy, affectedUsers: policy.mode === "off" ? 0 : 2, immediatelyRestrictedUsers: policy.gracePeriodDays === 0 ? 1 : 0, enrolledLocalAdministrators: 1 }; }
function currentUser(session: "user" | "admin" | "statusfail") { const admin = session === "admin"; return { user: { id: admin ? "0199ee6c-c777-7000-8000-000000020001" : "0199ee6c-c777-7000-8000-000000020002", email: admin ? "admin@example.test" : "user@example.test", display_name: admin ? "MFA Administrator" : "MFA User", is_instance_admin: admin }, session: { id: admin ? "0199ee6c-c777-7000-8000-000000020011" : "0199ee6c-c777-7000-8000-000000020012", last_seen_at: "2026-10-08T00:00:00Z", idle_expires_at: "2026-10-08T01:00:00Z", absolute_expires_at: "2026-10-09T00:00:00Z" } }; }
function sessionFrom(cookie?: string): "user" | "admin" | "statusfail" | undefined { if (cookie?.includes("nuriteo_dev_session=admin")) return "admin"; if (cookie?.includes("nuriteo_dev_session=statusfail")) return "statusfail"; if (cookie?.includes("nuriteo_dev_session=user")) return "user"; return undefined; }
function sessionCookieValue(cookie?: string): string | undefined { return cookie?.match(/(?:^|;\s*)nuriteo_dev_session=([^;]+)/u)?.[1]; }
function populationProof(): string { return `p${String(populationRevision).padStart(42, "0")}`; }
function header(request: http.IncomingMessage, name: string): string | undefined { const value = request.headers[name]; return Array.isArray(value) ? value[0] : value; }
async function bodyOf(request: http.IncomingMessage): Promise<Record<string, unknown>> { const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk)); return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>; }
function json(response: http.ServerResponse, value: unknown): void { response.statusCode = 200; response.setHeader("content-type", "application/json"); response.end(JSON.stringify(value)); }
function problem(response: http.ServerResponse, status: number, code: string): void { response.statusCode = status; response.setHeader("content-type", "application/problem+json"); response.end(JSON.stringify({ type: "about:blank", title: "Rejected", status, detail: "Request rejected", instance: "/api/v1/mfa", code, request_id: "mfa-browser", errors: [] })); }
async function listen(server: http.Server): Promise<void> { await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); }); }
async function reservePort(): Promise<number> { const server = http.createServer(); await listen(server); const address = server.address(); assert.ok(address && typeof address !== "string"); await new Promise<void>((resolve) => server.close(() => resolve())); return address.port; }
async function ready(origin: string): Promise<void> { const deadline = Date.now() + 15_000; while (Date.now() < deadline) { if (web.exitCode !== null) throw new Error("standalone server exited"); try { if ((await fetch(`${origin}/sign-in`)).status < 500) return; } catch {} await new Promise((resolve) => setTimeout(resolve, 100)); } throw new Error("standalone server not ready"); }
async function stop(child: ReturnType<typeof spawn>): Promise<void> { if (child.exitCode !== null) return; child.kill("SIGTERM"); await Promise.race([new Promise((resolve) => child.once("exit", resolve)), new Promise((resolve) => setTimeout(resolve, 2_000))]); if (child.exitCode === null) child.kill("SIGKILL"); }
