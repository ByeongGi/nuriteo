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
const providerId = "0199ee6c-c777-7000-8000-000000090101";
const csrf = `nrt_csrf_${"g".repeat(43)}`;
let configured = false;
let state: "active" | "disabled" = "disabled";
let version = 1;
let displayName = "Company Git";
const mutations: Array<{
  path: string;
  csrf: string | undefined;
  origin: string | undefined;
  etag: string | undefined;
}> = [];

assert.ok(fs.existsSync(serverEntry), "Run the production build before this browser check.");
fs.cpSync(path.join(webRoot, ".next/static"), path.join(standaloneWeb, ".next/static"), {
  force: true,
  recursive: true
});

const core = http.createServer(async (request, response) => {
  const requestPath = request.url ?? "/";
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-request-id", "git-provider-browser");
  if (request.method === "GET" && requestPath === "/api/v1/me") return json(response, me());
  if (request.method === "GET" && requestPath === "/api/v1/mfa") return json(response, mfa());
  if (request.method === "GET" && requestPath.startsWith("/api/v1/notifications")) {
    return problem(response, 503, "UNAVAILABLE");
  }
  if (request.method === "GET" && requestPath === "/api/v1/admin/git-providers") {
    return json(response, configured ? [provider()] : []);
  }
  if (request.method !== "GET") {
    mutations.push({
      path: requestPath,
      csrf: header(request, "x-csrf-token"),
      origin: header(request, "origin"),
      etag: header(request, "if-match")
    });
    assert.equal(header(request, "authorization"), undefined);
    assert.equal(header(request, "x-git-token"), undefined);
  }
  if (request.method === "POST" && requestPath === "/api/v1/admin/git-providers") {
    const body = await bodyOf(request);
    assert.deepEqual(body, {
      displayName: "Company Git",
      kind: "generic",
      host: "git.internal.example",
      port: 443,
      apiBaseUrl: "https://git.internal.example/api",
      oauthAuthorizationUrl: null,
      oauthTokenUrl: null,
      oauthClientId: null,
      allowsRead: true,
      allowsWrite: true
    });
    configured = true;
    response.statusCode = 201;
    response.setHeader("etag", '"git-provider-v1"');
    return json(response, provider());
  }
  if (request.method === "PATCH" && requestPath === `/api/v1/admin/git-providers/${providerId}`) {
    const body = await bodyOf(request);
    assert.equal(body.displayName, "Company Git updated");
    displayName = String(body.displayName);
    version = 2;
    response.setHeader("etag", '"git-provider-v2"');
    return json(response, provider());
  }
  if (request.method === "POST" && requestPath === `/api/v1/admin/git-providers/${providerId}/activate`) {
    state = "active";
    version = 3;
    response.setHeader("etag", '"git-provider-v3"');
    return json(response, provider());
  }
  if (request.method === "POST" && requestPath === `/api/v1/admin/git-providers/${providerId}/disable`) {
    state = "disabled";
    version = 4;
    response.setHeader("etag", '"git-provider-v4"');
    return json(response, provider());
  }
  if (request.method === "DELETE" && requestPath === `/api/v1/admin/git-providers/${providerId}`) {
    configured = false;
    response.statusCode = 204;
    return response.end();
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
for (const stream of [web.stdout, web.stderr]) {
  stream.on("data", (chunk: Buffer) => {
    output = `${output}${chunk.toString("utf8")}`.slice(-4_000);
  });
}

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
    await page.goto(`${origin}/admin/git-providers`, { waitUntil: "networkidle" });
    await page.getByRole("heading", { name: "Git providers" }).waitFor();
    await page.getByLabel("Display name").first().fill("Company Git");
    await page.getByLabel("Exact host").fill("git.internal.example");
    await page.getByLabel("API base URL").first().fill("https://git.internal.example/api");
    await page.getByLabel("Allow write").first().check();
    const invalidFields = await page.locator("form").first().locator(":invalid").evaluateAll((nodes) => nodes.map((node) => ({ name: (node as HTMLInputElement).name, message: (node as HTMLInputElement).validationMessage })));
    assert.deepEqual(invalidFields, []);
    await page.getByRole("button", { name: "Save disabled provider" }).click();
    await page.waitForTimeout(500);
    let feedback = page.locator('main [role="status"], main [role="alert"]');
    assert.match((await feedback.allInnerTexts()).join(" "), /saved disabled/u);
    assert.equal(await page.getByRole("region", { name: "Private certificate authority" }).count(), 1);

    await page.getByLabel("Display name").last().fill("Company Git updated");
    await page.getByRole("button", { name: "Update provider" }).click();
    await page.getByRole("status").filter({ hasText: "Provider updated" }).waitFor();
    await page.getByRole("button", { name: "Validate and activate" }).click();
    await page.getByRole("status").filter({ hasText: "validated and activated" }).waitFor();
    await page.getByRole("button", { name: "Disable", exact: true }).click();
    await page.getByRole("status").filter({ hasText: "disabled immediately" }).waitFor();
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "Delete" }).click();
    await page.getByText("No Git provider is configured.").waitFor();

    assert.deepEqual(mutations.map(({ path }) => path), [
      "/api/v1/admin/git-providers",
      `/api/v1/admin/git-providers/${providerId}`,
      `/api/v1/admin/git-providers/${providerId}/activate`,
      `/api/v1/admin/git-providers/${providerId}/disable`,
      `/api/v1/admin/git-providers/${providerId}`
    ]);
    assert.ok(mutations.every((entry) => entry.csrf === csrf && entry.origin === origin));
    assert.deepEqual(mutations.map(({ etag }) => etag), [
      undefined,
      '"git-provider-v1"',
      '"git-provider-v2"',
      '"git-provider-v3"',
      '"git-provider-v4"'
    ]);
    await context.close();
  } finally {
    await browser.close();
  }
} catch (error) {
  throw new Error(`Git provider browser journey failed after ${mutations.length} mutations (${mutations.map(({ path }) => path).join(", ")}); server output: ${output}`, { cause: error });
} finally {
  await stop(web);
  await new Promise<void>((resolve) => core.close(() => resolve()));
}

console.log("web Git provider admin lifecycle browser journey ok");

function provider() {
  return {
    id: providerId,
    displayName,
    kind: "generic",
    host: "git.internal.example",
    port: 443,
    apiBaseUrl: "https://git.internal.example/api",
    oauthAuthorizationUrl: null,
    oauthTokenUrl: null,
    oauthClientId: null,
    state,
    allowsRead: true,
    allowsWrite: true,
    configVersion: version,
    validatedAt: state === "active" ? "2026-10-08T01:00:00Z" : null
  };
}
function me() { return { user: { id: "0199ee6c-c777-7000-8000-000000090111", email: "admin@example.test", display_name: "admin", is_instance_admin: true }, session: { id: "0199ee6c-c777-7000-8000-000000090112", last_seen_at: "2026-10-08T00:00:00Z", idle_expires_at: "2026-10-08T01:00:00Z", absolute_expires_at: "2026-10-09T00:00:00Z" } }; }
function mfa() { return { localAccount: true, enrolled: false, pendingEnrollment: false, recoveryCodesRemaining: 0, policyMode: "off", gracePeriodDays: 7, required: false, deadlineAt: null, restricted: false, notificationState: "none" }; }
function header(request: http.IncomingMessage, name: string) { const value = request.headers[name]; return Array.isArray(value) ? value[0] : value; }
async function bodyOf(request: http.IncomingMessage) { const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk)); return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>; }
function json(response: http.ServerResponse, value: unknown) { if (response.statusCode < 200) response.statusCode = 200; response.setHeader("content-type", "application/json"); response.end(JSON.stringify(value)); }
function problem(response: http.ServerResponse, status: number, code: string) { response.statusCode = status; response.setHeader("content-type", "application/problem+json"); response.end(JSON.stringify({ type: "about:blank", title: "Rejected", status, detail: "Rejected", instance: "/api/v1", code, request_id: "git-provider-browser", errors: [] })); }
async function listen(server: http.Server) { await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); }); }
async function reservePort() { const server = http.createServer(); await listen(server); const address = server.address(); assert.ok(address && typeof address !== "string"); await new Promise<void>((resolve) => server.close(() => resolve())); return address.port; }
async function ready(origin: string) { const deadline = Date.now() + 15_000; while (Date.now() < deadline) { if (web.exitCode !== null) throw new Error("standalone server exited"); try { if ((await fetch(`${origin}/sign-in`)).status < 500) return; } catch {} await new Promise((resolve) => setTimeout(resolve, 100)); } throw new Error("standalone server not ready"); }
async function stop(child: ReturnType<typeof spawn>) { if (child.exitCode !== null) return; child.kill("SIGTERM"); await Promise.race([new Promise((resolve) => child.once("exit", resolve)), new Promise((resolve) => setTimeout(resolve, 2_000))]); if (child.exitCode === null) child.kill("SIGKILL"); }

export {};
