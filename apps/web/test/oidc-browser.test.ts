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
const firstId = "0199ee6c-c777-7000-8000-000000060001";
const secondId = "0199ee6c-c777-7000-8000-000000060002";
const createdId = "0199ee6c-c777-7000-8000-000000060003";
const csrf = `nrt_csrf_${"o".repeat(43)}`;
let created = false;
const mutations: Array<{ path: string; csrf: string | undefined; origin: string | undefined; etag: string | undefined }> = [];

assert.ok(fs.existsSync(serverEntry), "Run the production build before this browser check.");
fs.cpSync(path.join(webRoot, ".next/static"), path.join(standaloneWeb, ".next/static"), { force: true, recursive: true });

const core = http.createServer(async (request, response) => {
  const requestPath = request.url ?? "/";
  const session = request.headers.cookie?.includes("nuriteo_dev_session=admin") ? "admin" : request.headers.cookie?.includes("nuriteo_dev_session=user") ? "user" : undefined;
  response.setHeader("cache-control", "no-store"); response.setHeader("x-request-id", "oidc-browser");
  if (request.method === "GET" && requestPath === "/api/v1/auth/oidc/providers") return json(response, { items: [{ id: firstId, displayName: "Corporate SSO" }, { id: secondId, displayName: "Partner SSO" }] });
  if (request.method === "GET" && requestPath === `/api/v1/auth/oidc/${firstId}/begin`) { response.statusCode = 303; response.setHeader("location", "https://id-one.example.test/authorize"); response.setHeader("set-cookie", "nuriteo_dev_oidc_binding=opaque; HttpOnly; SameSite=Lax; Path=/"); return response.end(); }
  if (request.method === "GET" && requestPath === "/api/v1/me") return session ? json(response, me(session)) : problem(response, 401, "AUTHENTICATION_REQUIRED");
  if (session === undefined) return problem(response, 401, "AUTHENTICATION_REQUIRED");
  if (request.method === "GET" && requestPath === "/api/v1/mfa") return json(response, { localAccount: true, enrolled: false, pendingEnrollment: false, recoveryCodesRemaining: 0, policyMode: "off", gracePeriodDays: 7, required: false, deadlineAt: null, restricted: false, notificationState: "none" });
  if (request.method === "GET" && requestPath.startsWith("/api/v1/notifications")) return problem(response, 503, "UNAVAILABLE");
  if (request.method === "GET" && requestPath === "/api/v1/admin/oidc/providers") return json(response, { items: created ? [provider(createdId, "Engineering SSO")] : [] });
  if (request.method === "GET" && requestPath === "/api/v1/me/oidc-identities") return json(response, { items: [{ providerId: firstId, providerDisplayName: "Corporate SSO", linkedAt: "2026-10-08T00:00:00Z", lastAuthenticatedAt: "2026-10-08T01:00:00Z" }] });
  if (request.method !== "GET") mutations.push({ path: requestPath, csrf: header(request, "x-csrf-token"), origin: header(request, "origin"), etag: header(request, "if-match") });
  if (request.method === "POST" && requestPath === "/api/v1/admin/oidc/providers") { const body = await bodyOf(request); assert.equal(body.clientSecret, "top-secret"); created = true; response.statusCode = 201; return json(response, provider(createdId, "Engineering SSO")); }
  if (request.method === "DELETE" && requestPath === `/api/v1/me/oidc-identities/${firstId}`) { response.statusCode = 204; response.setHeader("set-cookie", ["nuriteo_dev_session=user-rotated; HttpOnly; SameSite=Strict; Path=/", `nuriteo_dev_csrf=${csrf}; SameSite=Strict; Path=/`]); return response.end(); }
  response.statusCode = 404; response.end();
});

await listen(core); const address = core.address(); assert.ok(address && typeof address !== "string"); const webPort = await reservePort();
const web = spawn(process.execPath, [serverEntry], { cwd: standaloneWeb, env: { ...process.env, HOSTNAME: "127.0.0.1", NURITEO_INTERNAL_API_URL: `http://127.0.0.1:${address.port}`, PORT: String(webPort) }, stdio: ["ignore", "pipe", "pipe"] });
let output = ""; for (const stream of [web.stdout, web.stderr]) stream.on("data", (chunk: Buffer) => { output = `${output}${chunk.toString("utf8")}`.slice(-4_000); });

try {
  const origin = `http://127.0.0.1:${webPort}`; await ready(origin); const browser = await chromium.launch({ headless: true });
  try {
    const anonymous = await browser.newContext(); const signIn = await anonymous.newPage();
    await signIn.goto(`${origin}/sign-in`, { waitUntil: "networkidle" });
    const corporate = signIn.getByRole("link", { name: "Continue with Corporate SSO" });
    assert.equal(await corporate.count(), 1);
    assert.equal(await signIn.getByRole("link", { name: "Continue with Partner SSO" }).count(), 1);
    assert.equal(await signIn.getByRole("button", { name: "Sign in" }).count(), 1);
    assert.equal(await corporate.getAttribute("href"), `/api/v1/auth/oidc/${firstId}/begin`);

    const admin = await browser.newContext(); await admin.addCookies([{ name: "nuriteo_dev_session", value: "admin", url: origin }, { name: "nuriteo_dev_csrf", value: csrf, url: origin }]); const adminPage = await admin.newPage();
    await adminPage.goto(`${origin}/admin/oidc`, { waitUntil: "networkidle" }); await adminPage.getByRole("heading", { name: "Identity providers" }).waitFor();
    await adminPage.getByLabel("Display name").first().fill("Engineering SSO"); await adminPage.getByLabel("Issuer URL").fill("https://id.example.test"); await adminPage.getByLabel("Client ID").first().fill("nuriteo"); await adminPage.getByLabel("Client secret").fill("top-secret"); await adminPage.getByRole("button", { name: "Save disabled Provider" }).click();
    await adminPage.getByRole("status").filter({ hasText: "disabled state" }).waitFor(); assert.equal(await adminPage.getByText("top-secret").count(), 0);

    const user = await browser.newContext(); await user.addCookies([{ name: "nuriteo_dev_session", value: "user", url: origin }, { name: "nuriteo_dev_csrf", value: csrf, url: origin }]); const identities = await user.newPage();
    await identities.goto(`${origin}/identities`, { waitUntil: "networkidle" }); await identities.getByRole("heading", { name: "Connected identities" }).waitFor(); await identities.getByRole("button", { name: "Disconnect" }).click(); await identities.getByRole("status").filter({ hasText: "session was rotated" }).waitFor();
    assert.ok(mutations.every((entry) => entry.csrf === csrf && entry.origin === origin));
    await Promise.all([anonymous.close(), admin.close(), user.close()]);
  } finally { await browser.close(); }
} catch (error) { throw new Error(`OIDC browser journey failed; server output: ${output}`, { cause: error }); }
finally { await stop(web); await new Promise<void>((resolve) => core.close(() => resolve())); }

console.log("web two-provider OIDC and recovery journey ok");

function provider(id: string, displayName: string) { return { id, displayName, issuer: "https://id.example.test", clientId: "nuriteo", state: "disabled", configVersion: 1, secretVersion: 1, linkedIdentityCount: 0, createdAt: "2026-10-08T00:00:00Z", updatedAt: "2026-10-08T00:00:00Z" }; }
function me(session: "admin" | "user") { return { user: { id: session === "admin" ? "0199ee6c-c777-7000-8000-000000060011" : "0199ee6c-c777-7000-8000-000000060012", email: `${session}@example.test`, display_name: session, is_instance_admin: session === "admin" }, session: { id: "0199ee6c-c777-7000-8000-000000060013", last_seen_at: "2026-10-08T00:00:00Z", idle_expires_at: "2026-10-08T01:00:00Z", absolute_expires_at: "2026-10-09T00:00:00Z" } }; }
function header(request: http.IncomingMessage, name: string) { const value = request.headers[name]; return Array.isArray(value) ? value[0] : value; }
async function bodyOf(request: http.IncomingMessage) { const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk)); return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>; }
function json(response: http.ServerResponse, value: unknown) { if (response.statusCode === 200 || response.statusCode === undefined) response.statusCode = 200; response.setHeader("content-type", "application/json"); response.end(JSON.stringify(value)); }
function problem(response: http.ServerResponse, status: number, code: string) { response.statusCode = status; response.setHeader("content-type", "application/problem+json"); response.end(JSON.stringify({ type: "about:blank", title: "Rejected", status, detail: "Rejected", instance: "/api/v1", code, request_id: "oidc-browser", errors: [] })); }
async function listen(server: http.Server) { await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); }); }
async function reservePort() { const server = http.createServer(); await listen(server); const address = server.address(); assert.ok(address && typeof address !== "string"); await new Promise<void>((resolve) => server.close(() => resolve())); return address.port; }
async function ready(origin: string) { const deadline = Date.now() + 15_000; while (Date.now() < deadline) { if (web.exitCode !== null) throw new Error("standalone server exited"); try { if ((await fetch(`${origin}/sign-in`)).status < 500) return; } catch {} await new Promise((resolve) => setTimeout(resolve, 100)); } throw new Error("standalone server not ready"); }
async function stop(child: ReturnType<typeof spawn>) { if (child.exitCode !== null) return; child.kill("SIGTERM"); await Promise.race([new Promise((resolve) => child.once("exit", resolve)), new Promise((resolve) => setTimeout(resolve, 2_000))]); if (child.exitCode === null) child.kill("SIGKILL"); }
