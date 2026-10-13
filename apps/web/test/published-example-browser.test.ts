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
const publicId = "ExESEhISEhISEhISEhISEhISEhISEhISEhISEhISEgA";
const userId = "0199ee6c-c777-7000-8000-00000000e101";
const userScopeId = "0199ee6c-c777-7000-8000-00000000e102";
const organizationId = "0199ee6c-c777-7000-8000-00000000e201";
const organizationScopeId = "0199ee6c-c777-7000-8000-00000000e202";
const projectId = "0199ee6c-c777-7000-8000-00000000e301";
const csrf = `nrt_csrf_${"p".repeat(43)}`;
const fixedPath = `/api/v1/published-examples/${publicId}/versions/3`;
const forkPath = `${fixedPath}/forks`;
const publicGets: http.IncomingMessage[] = [];
const forkRequests: ForkRequest[] = [];
let publicOrigin = "";

assert.ok(fs.existsSync(serverEntry), "Run the production build before this browser check.");
fs.cpSync(path.join(webRoot, ".next/static"), path.join(standaloneWeb, ".next/static"), {
  force: true,
  recursive: true
});

const core = http.createServer(async (request, response) => {
  const requestPath = request.url ?? "/";
  const session = cookie(request, "nuriteo_dev_session");
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-request-id", "published-example-browser");

  if (request.method === "GET" && requestPath === fixedPath) {
    publicGets.push(request);
    return json(response, publicExample());
  }
  if (request.method === "GET" && requestPath === "/api/v1/me/workspaces") {
    if (session === undefined) return problem(response, 401, "AUTHENTICATION_REQUIRED");
    return json(response, { workspaces: workspaces() });
  }
  if (request.method === "POST" && requestPath === forkPath) {
    const body = await bodyOf(request);
    forkRequests.push({
      authorization: header(request, "authorization"),
      body,
      cookie: header(request, "cookie"),
      csrf: header(request, "x-csrf-token"),
      idempotencyKey: header(request, "idempotency-key"),
      origin: header(request, "origin")
    });
    if (session === "expires") return problem(response, 401, "AUTHENTICATION_REQUIRED");
    assert.equal(session, "active");
    if (forkRequests.filter((entry) => entry.cookie?.includes("active")).length === 1) {
      return problem(response, 503, "COMMIT_OUTCOME_UNKNOWN");
    }
    response.setHeader(
      "location",
      `/api/v1/workspaces/organizations/${organizationId}/projects/${projectId}`
    );
    return json(response, forkResult(), 201);
  }

  if (request.method === "GET" && requestPath === "/api/v1/me") {
    if (session !== "active") return problem(response, 401, "AUTHENTICATION_REQUIRED");
    return json(response, currentUser());
  }
  if (request.method === "GET" && requestPath === "/api/v1/mfa") return json(response, mfa());
  if (request.method === "GET" && requestPath.startsWith("/api/v1/notifications")) {
    return problem(response, 503, "UNAVAILABLE");
  }
  if (request.method === "GET" && requestPath.startsWith(`/api/v1/workspaces/organizations/${organizationId}/projects?`)) {
    return json(response, { items: [project()], nextCursor: null });
  }
  if (request.method === "GET" && requestPath === `/api/v1/workspaces/organizations/${organizationId}/projects/${projectId}`) {
    response.setHeader("etag", '"project-v1"');
    return json(response, project());
  }
  if (request.method === "GET" && requestPath.startsWith(`/api/v1/workspaces/organizations/${organizationId}/projects/${projectId}/roles`)) {
    return json(response, { items: [], nextCursor: null });
  }
  if (request.method === "GET" && requestPath.startsWith(`/api/v1/organizations/${organizationId}/members`)) {
    return json(response, { items: [] });
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
  env: {
    ...process.env,
    HOSTNAME: "127.0.0.1",
    NURITEO_INTERNAL_API_URL: `http://127.0.0.1:${coreAddress.port}`,
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
  publicOrigin = `http://127.0.0.1:${webPort}`;
  await ready(publicOrigin);
  const browser = await chromium.launch({ headless: true });
  try {
    await fixedVersionForkJourney(browser);
    await signedOutWorkspaceJourney(browser);
    await expiredForkSessionJourney(browser);
  } finally {
    await browser.close();
  }

  assert.ok(publicGets.length >= 3);
  for (const request of publicGets) {
    assert.equal(header(request, "cookie"), undefined);
    assert.equal(header(request, "authorization"), undefined);
    assert.equal(header(request, "origin"), undefined);
    assert.equal(header(request, "x-csrf-token"), undefined);
    assert.equal(header(request, "idempotency-key"), undefined);
  }
} catch (error) {
  throw new Error(`Published Example browser journey failed; server output: ${output}`, { cause: error });
} finally {
  await stop(web);
  await new Promise<void>((resolve) => core.close(() => resolve()));
}

console.log("PUB-002 browser journey ok (fixed version, destination, retry key, navigation, 401 UX)");

async function fixedVersionForkJourney(browser: Awaited<ReturnType<typeof chromium.launch>>): Promise<void> {
  const context = await browser.newContext({
    extraHTTPHeaders: { authorization: "Bearer must-not-reach-public-core" }
  });
  await context.addCookies([
    { name: "nuriteo_dev_session", value: "active", url: publicOrigin },
    { name: "nuriteo_dev_csrf", value: csrf, url: publicOrigin }
  ]);
  const page = await context.newPage();
  await page.goto(`${publicOrigin}/examples/${publicId}/versions/3`, { waitUntil: "networkidle" });
  await page.getByText("Fixed snapshot", { exact: true }).waitFor();
  await page.getByText("This public view is pinned to version 3.", { exact: false }).waitFor();
  await page.getByLabel("Workspace").selectOption(organizationScopeId);
  await page.getByLabel("Project slug").fill("browser-fixed-fork");
  await page.getByLabel("Project name").fill("Browser fixed fork");

  await page.getByRole("button", { name: "Fork into Workspace" }).click();
  await page.getByRole("alert").filter({ hasText: "Retry with the same values" }).waitFor();
  await Promise.all([
    page.waitForURL(`**/projects?workspace=${organizationScopeId}&project=${projectId}`),
    page.getByRole("button", { name: "Fork into Workspace" }).click()
  ]);

  const activeForks = forkRequests.filter((entry) => entry.cookie?.includes("active"));
  assert.equal(activeForks.length, 2);
  assert.equal(activeForks[0]?.idempotencyKey, activeForks[1]?.idempotencyKey);
  assert.match(activeForks[0]?.idempotencyKey ?? "", /^published-example-fork-[0-9a-f-]{36}$/u);
  for (const request of activeForks) {
    assert.equal(request.origin, publicOrigin);
    assert.equal(request.csrf, csrf);
    assert.equal(request.authorization, undefined);
    assert.match(request.cookie ?? "", /nuriteo_dev_session=active/u);
    assert.deepEqual(request.body, {
      destinationOwner: { ownerType: "organization", ownerId: organizationId },
      slug: "browser-fixed-fork",
      name: "Browser fixed fork"
    });
  }
  await context.close();
}

async function signedOutWorkspaceJourney(browser: Awaited<ReturnType<typeof chromium.launch>>): Promise<void> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`${publicOrigin}/examples/${publicId}/versions/3`, { waitUntil: "networkidle" });
  await page.getByRole("link", { name: "Sign in to fork" }).waitFor();
  await context.close();
}

async function expiredForkSessionJourney(browser: Awaited<ReturnType<typeof chromium.launch>>): Promise<void> {
  const context = await browser.newContext();
  await context.addCookies([
    { name: "nuriteo_dev_session", value: "expires", url: publicOrigin },
    { name: "nuriteo_dev_csrf", value: csrf, url: publicOrigin }
  ]);
  const page = await context.newPage();
  await page.goto(`${publicOrigin}/examples/${publicId}/versions/3`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Fork into Workspace" }).click();
  await page.getByRole("alert").filter({ hasText: "Your session ended" }).waitFor();
  await page.getByRole("link", { name: "Sign in to continue" }).waitFor();
  await context.close();
}

interface ForkRequest {
  readonly authorization: string | undefined;
  readonly body: Record<string, unknown>;
  readonly cookie: string | undefined;
  readonly csrf: string | undefined;
  readonly idempotencyKey: string | undefined;
  readonly origin: string | undefined;
}

function publicExample() {
  return {
    publicId,
    name: "Browser Example",
    visibility: "public",
    versionNumber: 3,
    publishedAt: "2026-10-08T00:00:00Z"
  };
}

function workspaces() {
  return [
    { ownerType: "user", ownerId: userId, displayLabel: "Personal", storageScopeId: userScopeId },
    { ownerType: "organization", ownerId: organizationId, displayLabel: "Team Workspace", storageScopeId: organizationScopeId }
  ];
}

function forkResult() {
  return {
    project: {
      id: projectId,
      ownerType: "organization",
      ownerId: organizationId,
      slug: "browser-fixed-fork",
      name: "Browser fixed fork",
      state: "active",
      version: 1,
      createdAt: "2026-10-08T00:00:00Z",
      updatedAt: "2026-10-08T00:00:00Z"
    },
    sourceVersionNumber: 3,
    idempotentRetry: false
  };
}

function project() {
  return {
    id: projectId,
    ownerType: "organization",
    ownerId: organizationId,
    slug: "browser-fixed-fork",
    name: "Browser fixed fork",
    state: "active",
    version: 1,
    createdAt: "2026-10-08T00:00:00Z",
    updatedAt: "2026-10-08T00:00:00Z",
    archivedAt: null,
    storageScopeId: organizationScopeId
  };
}

function currentUser() {
  return {
    user: { id: userId, email: "browser@example.test", display_name: "Browser user", is_instance_admin: false },
    session: {
      id: "0199ee6c-c777-7000-8000-00000000e401",
      last_seen_at: "2026-10-08T00:00:00Z",
      idle_expires_at: "2026-10-08T01:00:00Z",
      absolute_expires_at: "2026-10-09T00:00:00Z"
    }
  };
}

function mfa() {
  return {
    localAccount: true,
    enrolled: false,
    pendingEnrollment: false,
    recoveryCodesRemaining: 0,
    policyMode: "off",
    gracePeriodDays: 7,
    required: false,
    deadlineAt: null,
    restricted: false,
    notificationState: "none"
  };
}

function cookie(request: http.IncomingMessage, name: string): string | undefined {
  for (const part of (request.headers.cookie ?? "").split(";")) {
    const [candidate, value] = part.trim().split("=", 2);
    if (candidate === name) return value;
  }
  return undefined;
}

function header(request: http.IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

async function bodyOf(request: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

function json(response: http.ServerResponse, value: unknown, status = 200): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(value));
}

function problem(response: http.ServerResponse, status: number, code: string): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/problem+json");
  response.end(JSON.stringify({
    type: "about:blank",
    title: "Rejected",
    status,
    detail: "Rejected.",
    instance: forkPath,
    code,
    request_id: "published-example-browser",
    errors: []
  }));
}

async function listen(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
}

async function reservePort(): Promise<number> {
  const server = http.createServer();
  await listen(server);
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

async function ready(origin: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (web.exitCode !== null) throw new Error("standalone server exited");
    try {
      if ((await fetch(`${origin}/sign-in`)).status < 500) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("standalone server not ready");
}

async function stop(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 2_000))
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

export {};
