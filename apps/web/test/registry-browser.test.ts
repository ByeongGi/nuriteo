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
const registryId = "0199ee6c-c777-7000-8000-000000070001";
const csrf = `nrt_csrf_${"r".repeat(43)}`;
let configured = false;
let active = false;
const mutations: Array<{
  path: string;
  csrf: string | undefined;
  origin: string | undefined;
  etag: string | undefined;
}> = [];

assert.ok(fs.existsSync(serverEntry), "Run the production build before this browser check.");
fs.cpSync(path.join(webRoot, ".next/static"), path.join(standaloneWeb, ".next/static"), { force: true, recursive: true });

const core = http.createServer(async (request, response) => {
  const requestPath = request.url ?? "/";
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-request-id", "registry-browser");
  if (request.method === "GET" && requestPath === "/api/v1/me") return json(response, me());
  if (request.method === "GET" && requestPath === "/api/v1/mfa") return json(response, mfa());
  if (request.method === "GET" && requestPath.startsWith("/api/v1/notifications")) return problem(response, 503, "UNAVAILABLE");
  if (request.method === "GET" && requestPath === "/api/v1/admin/registries") {
    return json(response, { items: configured ? [registry()] : [], scopes: [] });
  }
  if (request.method !== "GET") mutations.push({
    path: requestPath,
    csrf: header(request, "x-csrf-token"),
    origin: header(request, "origin"),
    etag: header(request, "if-match")
  });
  if (request.method === "POST" && requestPath === "/api/v1/admin/registries") {
    const body = await bodyOf(request);
    assert.equal(body.token, "top-secret-registry-token");
    configured = true;
    response.statusCode = 201;
    return json(response, registry());
  }
  if (request.method === "POST" && requestPath === `/api/v1/admin/registries/${registryId}/activate`) {
    active = true;
    response.setHeader("etag", '"registry-v3"');
    return json(response, registry());
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
  env: {
    ...process.env,
    HOSTNAME: "127.0.0.1",
    NURITEO_INTERNAL_API_URL: `http://127.0.0.1:${address.port}`,
    PORT: String(webPort)
  },
  stdio: ["ignore", "pipe", "pipe"]
});
let output = "";
for (const stream of [web.stdout, web.stderr]) stream.on("data", (chunk: Buffer) => {
  output = `${output}${chunk.toString("utf8")}`.slice(-4_000);
});

try {
  const origin = `http://127.0.0.1:${webPort}`;
  await ready(origin);
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    await context.addCookies([
      { name: "nuriteo_dev_session", value: "admin", url: origin },
      { name: "nuriteo_dev_csrf", value: csrf, url: origin }
    ]);
    const page = await context.newPage();
    await page.goto(`${origin}/admin/registries`, { waitUntil: "networkidle" });
    await page.getByRole("heading", { name: "Package registries" }).waitFor();
    await page.getByLabel("Display name").first().fill("Company npm");
    await page.getByLabel("HTTPS base URL").fill("https://registry.example.test/npm");
    await page.getByLabel("Access token").fill("top-secret-registry-token");
    await page.getByRole("button", { name: "Save disabled Registry" }).click();
    await page.getByRole("status").filter({ hasText: "cannot be displayed again" }).waitFor();
    assert.equal(await page.getByText("top-secret-registry-token").count(), 0);
    await page.getByRole("button", { name: "Validate and activate" }).click();
    await page.getByRole("status").filter({ hasText: "validated and activated" }).waitFor();
    assert.deepEqual(mutations.map(({ path }) => path), [
      "/api/v1/admin/registries",
      `/api/v1/admin/registries/${registryId}/activate`
    ]);
    assert.ok(mutations.every((entry) => entry.csrf === csrf && entry.origin === origin));
    assert.equal(mutations[1]?.etag, '"registry-v2"');
    await context.close();
  } finally {
    await browser.close();
  }
} catch (error) {
  throw new Error(`Registry browser journey failed; server output: ${output}`, { cause: error });
} finally {
  await stop(web);
  await new Promise<void>((resolve) => core.close(() => resolve()));
}

console.log("web Registry credential and activation journey ok");

function registry() {
  return {
    id: registryId,
    displayName: "Company npm",
    baseUrl: "https://registry.example.test/npm",
    state: active ? "active" : "disabled",
    isDefault: false,
    configVersion: active ? 3 : 2,
    credentialVersion: 1,
    validatedAt: active ? "2026-10-08T00:00:00Z" : null
  };
}
function me() { return { user: { id: "0199ee6c-c777-7000-8000-000000070011", email: "admin@example.test", display_name: "admin", is_instance_admin: true }, session: { id: "0199ee6c-c777-7000-8000-000000070012", last_seen_at: "2026-10-08T00:00:00Z", idle_expires_at: "2026-10-08T01:00:00Z", absolute_expires_at: "2026-10-09T00:00:00Z" } }; }
function mfa() { return { localAccount: true, enrolled: false, pendingEnrollment: false, recoveryCodesRemaining: 0, policyMode: "off", gracePeriodDays: 7, required: false, deadlineAt: null, restricted: false, notificationState: "none" }; }
function header(request: http.IncomingMessage, name: string) { const value = request.headers[name]; return Array.isArray(value) ? value[0] : value; }
async function bodyOf(request: http.IncomingMessage) { const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk)); return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>; }
function json(response: http.ServerResponse, value: unknown) { if (response.statusCode < 200) response.statusCode = 200; response.setHeader("content-type", "application/json"); response.end(JSON.stringify(value)); }
function problem(response: http.ServerResponse, status: number, code: string) { response.statusCode = status; response.setHeader("content-type", "application/problem+json"); response.end(JSON.stringify({ type: "about:blank", title: "Rejected", status, detail: "Rejected", instance: "/api/v1", code, request_id: "registry-browser", errors: [] })); }
async function listen(server: http.Server) { await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); }); }
async function reservePort() { const server = http.createServer(); await listen(server); const address = server.address(); assert.ok(address && typeof address !== "string"); await new Promise<void>((resolve) => server.close(() => resolve())); return address.port; }
async function ready(origin: string) { const deadline = Date.now() + 15_000; while (Date.now() < deadline) { if (web.exitCode !== null) throw new Error("standalone server exited"); try { if ((await fetch(`${origin}/sign-in`)).status < 500) return; } catch {} await new Promise((resolve) => setTimeout(resolve, 100)); } throw new Error("standalone server not ready"); }
async function stop(child: ReturnType<typeof spawn>) { if (child.exitCode !== null) return; child.kill("SIGTERM"); await Promise.race([new Promise((resolve) => child.once("exit", resolve)), new Promise((resolve) => setTimeout(resolve, 2_000))]); if (child.exitCode === null) child.kill("SIGKILL"); }

export {};
