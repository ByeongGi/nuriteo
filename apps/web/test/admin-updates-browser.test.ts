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
const csrfToken = `nrt_csrf_${"u".repeat(43)}`;

assert.ok(fs.existsSync(serverEntry), "Run the production build before this browser check.");
fs.cpSync(path.join(webRoot, ".next/static"), path.join(standaloneWeb, ".next/static"), {
  force: true,
  recursive: true
});

let blocked = true;
let approvals = 0;
let maintenanceEnabled = false;
let maintenanceChanges = 0;
let observedApproval: unknown;
const core = http.createServer(async (request, response) => {
  const requestPath = request.url ?? "/";
  const session = sessionFrom(request.headers.cookie);
  response.setHeader("cache-control", "private, no-store");
  response.setHeader("x-request-id", "admin-updates-browser");
  if (session === undefined) return sendProblem(response, 401, "AUTHENTICATION_REQUIRED");
  if (request.method === "GET" && requestPath === "/api/v1/me") {
    return sendJson(response, currentUser(session));
  }
  if (request.method === "GET" && requestPath === "/api/v1/mfa") {
    return sendJson(response, {
      localAccount: true, enrolled: false, pendingEnrollment: false,
      recoveryCodesRemaining: 0, policyMode: "off", gracePeriodDays: 7,
      required: false, deadlineAt: null, restricted: false, notificationState: "none"
    });
  }
  if (request.method === "GET" && requestPath === "/api/v1/notifications?limit=1") {
    return sendJson(response, { items: [], nextCursor: null, unreadCount: 0 });
  }
  if (request.method === "GET" && requestPath === "/api/v1/maintenance") {
    return sendJson(response, {
      phase: maintenanceEnabled ? "maintenance" : "active",
      readOnly: maintenanceEnabled
    });
  }
  if (session !== "admin") return sendProblem(response, 403, "ADMIN_REQUIRED");
  if (request.method === "GET" && requestPath === "/api/v1/admin/maintenance") {
    return sendJson(response, {
      phase: maintenanceEnabled ? "maintenance" : "active",
      activeWrites: 0,
      writeAdmissionOpen: !maintenanceEnabled
    });
  }
  if (request.method === "PUT" && requestPath === "/api/v1/admin/maintenance") {
    if (header(request, "x-csrf-token") !== csrfToken) {
      return sendProblem(response, 403, "CSRF_REJECTED");
    }
    const body = await jsonBody(request) as { enabled?: unknown };
    if (typeof body.enabled !== "boolean") return sendProblem(response, 422, "VALIDATION_FAILED");
    maintenanceEnabled = body.enabled;
    maintenanceChanges += 1;
    return sendJson(response, {
      phase: maintenanceEnabled ? "maintenance" : "active",
      activeWrites: 0,
      writeAdmissionOpen: !maintenanceEnabled
    });
  }
  if (request.method === "GET" && requestPath === "/api/v1/admin/updates/readiness") {
    return sendJson(response, readiness());
  }
  if (request.method === "GET" && requestPath === "/api/v1/admin/updates/history") {
    return sendJson(response, {
      items: approvals === 0 ? [] : [{
        id: "0199ee6c-c777-7000-8000-000000024701",
        occurredAt: "2026-10-11T01:00:00Z",
        action: "approved",
        targetRelease: "self-hosted-v1-rc-lineage",
        result: "recorded"
      }]
    });
  }
  if (request.method === "POST" && requestPath === "/api/v1/admin/updates/approval") {
    observedApproval = await jsonBody(request);
    if (header(request, "x-csrf-token") !== csrfToken) {
      return sendProblem(response, 403, "CSRF_REJECTED");
    }
    if (blocked) return sendProblem(response, 409, "UPDATE_BLOCKED");
    approvals += 1;
    response.statusCode = 201;
    return sendJson(response, {
      id: "0199ee6c-c777-7000-8000-000000024701",
      approvedAt: "2026-10-11T01:00:00Z",
      targetRelease: "self-hosted-v1-rc-lineage",
      state: "approved",
      executionStarted: false
    });
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
let serverOutput = "";
for (const stream of [web.stdout, web.stderr]) {
  stream.on("data", (chunk: Buffer) => {
    serverOutput = `${serverOutput}${chunk.toString("utf8")}`.slice(-4_000);
  });
}

try {
  const origin = `http://127.0.0.1:${webPort}`;
  await waitUntilReady(origin);
  const browser = await chromium.launch({ headless: true });
  try {
    const member = await browser.newContext();
    await member.addCookies([{ name: "nuriteo_dev_session", value: "member", url: origin }]);
    const memberPage = await member.newPage();
    await memberPage.goto(`${origin}/admin/updates`, { waitUntil: "networkidle" });
    await memberPage.getByRole("heading", { name: "Administrator access required" }).waitFor();
    await member.close();

    const admin = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await admin.addCookies([
      { name: "nuriteo_dev_session", value: "admin", url: origin },
      { name: "nuriteo_dev_csrf", value: csrfToken, url: origin }
    ]);
    const page = await admin.newPage();
    await page.goto(`${origin}/admin/updates`, { waitUntil: "networkidle" });
    await page.getByRole("heading", { name: "Resolve blockers before approval" }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Record update approval" }).count(), 0);
    assert.equal(await page.getByText(/postgres:\/\//).count(), 0);

    blocked = false;
    await page.reload({ waitUntil: "networkidle" });
    const approve = page.getByRole("button", { name: "Record update approval" });
    assert.equal(await approve.isDisabled(), true);
    await page.getByRole("checkbox").check();
    await approve.click();
    await page.getByRole("status").filter({ hasText: "No update was started" }).waitFor();
    await page.getByRole("heading", { name: "Recent update approvals" }).waitFor();
    assert.equal(approvals, 1);
    assert.deepEqual(observedApproval, {
      targetRelease: "self-hosted-v1-rc-lineage",
      acknowledged: true
    });

    await page.goto(`${origin}/admin/maintenance`, { waitUntil: "networkidle" });
    await page.getByRole("heading", { name: "Enter maintenance mode" }).waitFor();
    await page.getByRole("checkbox").check();
    await page.getByRole("button", { name: "Enter maintenance mode" }).click();
    await page.getByRole("status").filter({ hasText: "Maintenance mode is active" }).waitFor();
    await page.getByText("Projects are read only while an administrator completes maintenance.").waitFor();
    assert.equal(maintenanceChanges, 1);

    await page.getByRole("checkbox").check();
    await page.getByRole("button", { name: "Resume writes" }).click();
    await page.getByRole("status").filter({ hasText: "Maintenance mode ended" }).waitFor();
    assert.equal(maintenanceChanges, 2);
    assert.equal(maintenanceEnabled, false);
    await admin.close();
  } finally {
    await browser.close();
  }
} catch (error) {
  throw new Error(`${String(error)}\nStandalone output:\n${serverOutput}`);
} finally {
  await stopChild(web);
  await new Promise<void>((resolve) => core.close(() => resolve()));
}

function readiness() {
  return {
    generatedAt: "2026-10-11T00:00:00Z",
    currentRelease: "0.1.0",
    targetRelease: "self-hosted-v1-rc-lineage",
    state: blocked ? "blocked" : "ready",
    approvalAllowed: !blocked,
    compatibility: {
      releaseLineage: "nuriteo-self-hosted-v1",
      sourceMigration: 46,
      configurationRegistryVersion: 4,
      schemaPolicy: "forward-only exact-prefix",
      objectPolicy: "read-in-place; rewrite forbidden",
      imagePolicy: "complete digest-pinned release set",
      failurePolicy: "stop-before-mutation"
    },
    preflight: {
      state: blocked ? "blocked" : "passed",
      schemaState: blocked ? null : "upgrade-required",
      currentMigration: blocked ? null : 46,
      targetMigration: blocked ? null : 47,
      blockerCode: blocked ? "schema-dirty" : null
    },
    blockers: blocked ? [{
      code: "schema-dirty",
      summary: "The migration history contains an incomplete migration.",
      operatorAction: "Resolve the interrupted migration before approving an update."
    }] : []
  };
}

function currentUser(session: "admin" | "member") {
  const admin = session === "admin";
  return {
    user: {
      id: admin ? "0199ee6c-c777-7000-8000-000000010001" : "0199ee6c-c777-7000-8000-000000010101",
      email: admin ? "admin@example.test" : "member@example.test",
      display_name: admin ? "Instance Administrator" : "Team Member",
      is_instance_admin: admin
    },
    session: {
      id: admin ? "0199ee6c-c777-7000-8000-000000010002" : "0199ee6c-c777-7000-8000-000000010102",
      last_seen_at: "2026-10-11T00:00:00Z",
      idle_expires_at: "2026-10-11T01:00:00Z",
      absolute_expires_at: "2026-10-12T00:00:00Z"
    }
  };
}

function sessionFrom(cookie: string | undefined): "admin" | "member" | undefined {
  if (cookie?.includes("nuriteo_dev_session=admin")) return "admin";
  if (cookie?.includes("nuriteo_dev_session=member")) return "member";
  return undefined;
}

function header(request: http.IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

async function jsonBody(request: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sendJson(response: http.ServerResponse, value: unknown): void {
  if (response.statusCode === 200) response.statusCode = 200;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(value));
}

function sendProblem(response: http.ServerResponse, status: number, code: string): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/problem+json");
  response.end(JSON.stringify({
    type: "about:blank", title: "Request rejected", status,
    detail: "The request could not be completed.", instance: "/api/v1/admin/updates",
    code, request_id: "admin-updates-browser", errors: []
  }));
}

async function listen(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
}

async function reservePort(): Promise<number> {
  const reservation = http.createServer();
  await listen(reservation);
  const address = reservation.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((resolve, reject) => {
    reservation.close((error) => error ? reject(error) : resolve());
  });
  return port;
}

async function waitUntilReady(origin: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (web.exitCode !== null || web.signalCode !== null) {
      throw new Error("standalone server exited before readiness");
    }
    try {
      const response = await fetch(`${origin}/sign-in`, { redirect: "manual" });
      if (response.status < 500) return;
    } catch {
      // The standalone server is starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("standalone server did not become ready");
}

async function stopChild(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const exited = new Promise<boolean>((resolve) => child.once("exit", () => resolve(true)));
  const stopped = await Promise.race([
    exited,
    new Promise<false>((resolve) => setTimeout(() => resolve(false), 2_000))
  ]);
  if (stopped) return;
  child.kill("SIGKILL");
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 1_000))]);
}
