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
const csrfToken = `nrt_csrf_${"a".repeat(43)}`;

assert.ok(fs.existsSync(serverEntry), "Run the production build before this browser check.");
fs.cpSync(path.join(webRoot, ".next/static"), path.join(standaloneWeb, ".next/static"), {
  force: true,
  recursive: true
});

let settingValue = 168;
let settingVersion = 1;
const observedMutations: Array<{
  readonly body: unknown;
  readonly cookie: string;
  readonly csrf: string | undefined;
  readonly etag: string | undefined;
  readonly origin: string | undefined;
}> = [];
const observedPreviews: unknown[] = [];

const core = http.createServer(async (request, response) => {
  const requestPath = request.url ?? "/";
  const session = sessionFrom(request.headers.cookie);
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-request-id", "admin-settings-browser");

  if (session === undefined) return sendProblem(response, 401, "AUTHENTICATION_REQUIRED");
  if (request.method === "GET" && requestPath === "/api/v1/me") {
    return sendJson(response, currentUser(session));
  }
  if (request.method === "GET" && requestPath === "/api/v1/mfa") {
    return sendJson(response, {
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
    });
  }
  if (request.method === "GET" && requestPath === "/api/v1/notifications?limit=1") {
    return sendJson(response, { items: [], nextCursor: null, unreadCount: 0 });
  }
  if (request.method === "GET" && requestPath === "/api/v1/admin/settings") {
    if (session !== "admin") return sendProblem(response, 403, "ADMIN_REQUIRED");
    return sendJson(response, { registryVersion: 1, items: settings() });
  }
  if (request.method === "GET" && requestPath === "/api/v1/admin/status") {
    if (session !== "admin") return sendProblem(response, 403, "ADMIN_REQUIRED");
    return sendJson(response, {
      releaseVersion: "0.1.0-beta.1",
      schemaVersion: 24,
      settingRegistryVersion: 1,
      settingCount: settings().length,
      restartRequired: false
    });
  }
  if (request.method === "GET" && requestPath === "/api/v1/admin/policy-cleanup/preview?batchLimit=100") {
    if (session !== "admin") return sendProblem(response, 403, "ADMIN_REQUIRED");
    return sendJson(response, {
      gcEnabled: true,
      gracePeriodSeconds: 86_400,
      eligibleCandidates: 3,
      expectedReclaimBytes: "4096",
      batchLimit: 100,
      dryRun: true
    });
  }
  if (request.method === "GET" && requestPath === "/api/v1/admin/operations") {
    if (session !== "admin") return sendProblem(response, 403, "ADMIN_REQUIRED");
    return sendJson(response, {
      generatedAt: "2026-10-07T12:00:00Z",
      overallState: "degraded",
      dependencies: { state: "degraded", category: "object_storage" },
      cleanup: {
        state: "nominal",
        queueDepth: 4,
        oldestEligibleAgeSeconds: 75,
        runningCount: 1,
        retryCount: 2,
        failedCount: 0
      },
      usage: {
        state: "nominal",
        activeUsers: 8,
        activeOrganizations: 2,
        activeProjects: 12,
        verifiedBundles: 24,
        trackedPhysicalBytes: "1073741824",
        reservedBytes: "1048576"
      },
      supportBundle: {
        format: "nuriteo-support-bundle-v1+json",
        maximumBytes: 65536,
        includes: ["release and non-sensitive runtime identity", "dependency health"],
        excludes: ["Project source", "authentication material"]
      }
    });
  }
  if (request.method === "GET" && requestPath === "/api/v1/admin/support-bundle") {
    if (session !== "admin") return sendProblem(response, 403, "ADMIN_REQUIRED");
    return sendJson(response, {
      schemaVersion: 1,
      format: "nuriteo-support-bundle-v1+json",
      generatedAt: "2026-10-12T12:00:00Z",
      diagnostics: [{ component: "dependencies", state: "degraded", code: "object_storage" }]
    });
  }
  if (
    request.method === "POST" &&
    requestPath === "/api/v1/admin/settings/invitations.default_expiry_hours/impact"
  ) {
    const body = await jsonBody(request);
    observedPreviews.push(body);
    if (session !== "admin") return sendProblem(response, 403, "ADMIN_REQUIRED");
    if (header(request, "x-csrf-token") !== csrfToken) return sendProblem(response, 403, "CSRF_REJECTED");
    return sendJson(response, {
      key: "invitations.default_expiry_hours",
      direction: isRecord(body) && typeof body.value === "number" && body.value < settingValue ? "decrease" : "increase",
      applyScope: "new_resources",
      affectedResources: 4,
      nonCompliantResources: 0,
      gracePeriodSeconds: null,
      requiresRecentReauthentication: false,
      automaticallyDeletesExistingData: false
    });
  }
  if (
    request.method === "PATCH" &&
    requestPath === "/api/v1/admin/settings/invitations.default_expiry_hours"
  ) {
    const body = await jsonBody(request);
    observedMutations.push({
      body,
      cookie: request.headers.cookie ?? "",
      csrf: header(request, "x-csrf-token"),
      etag: header(request, "if-match"),
      origin: header(request, "origin")
    });
    if (session !== "admin") return sendProblem(response, 403, "ADMIN_REQUIRED");
    if (header(request, "x-csrf-token") !== csrfToken) {
      return sendProblem(response, 403, "CSRF_REJECTED");
    }
    if (header(request, "if-match") !== `"setting-v${settingVersion}"`) {
      return sendProblem(response, 412, "SETTING_VERSION_STALE");
    }
    if (!isRecord(body) || typeof body.value !== "number") {
      return sendProblem(response, 422, "VALIDATION_FAILED");
    }
    settingValue = body.value;
    settingVersion += 1;
    response.setHeader("etag", `"setting-v${settingVersion}"`);
    return sendJson(response, setting());
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
    const admin = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await admin.addCookies([
      { name: "nuriteo_dev_session", value: "admin", url: origin },
      { name: "nuriteo_dev_csrf", value: csrfToken, url: origin }
    ]);
    const page = await admin.newPage();
    await page.goto(`${origin}/admin/settings`, { waitUntil: "networkidle" });
    await page.getByRole("heading", { level: 1, name: "Settings" }).waitFor();
    assert.equal(await page.getByText("0.1.0-beta.1", { exact: true }).count(), 1);
    assert.equal(await page.getByText("Up to date", { exact: true }).count(), 1);

    const settingsLink = page.getByRole("navigation", { name: "Administration" })
      .getByRole("link", { name: "Settings" });
    const invitationsLink = page.getByRole("navigation", { name: "Administration" })
      .getByRole("link", { name: "Activation invitations" });
    assert.equal(await settingsLink.getAttribute("aria-current"), "page");
    await settingsLink.focus();
    await page.keyboard.press("Tab");
    assert.equal(await invitationsLink.evaluate((element) => element === document.activeElement), true);

    const invitationForm = page.locator("form").filter({ hasText: "Invitation expiry" });
    const expiry = invitationForm.getByLabel("Invitation expiry");
    assert.equal(await expiry.inputValue(), "168");
    assert.equal(await page.getByText("3", { exact: true }).count() > 0, true);
    await expiry.fill("0");
    await invitationForm.getByRole("button", { name: "Review impact" }).click();
    await invitationForm.getByRole("alert").filter({ hasText: "outside its allowed range" }).waitFor();
    assert.equal(observedPreviews.length, 0);
    await expiry.fill("336");
    assert.equal(await invitationForm.getByRole("button", { name: "Apply change" }).isDisabled(), true);
    await invitationForm.getByRole("button", { name: "Review impact" }).click();
    await invitationForm.getByText("Existing data will not be deleted automatically.").waitFor();
    await invitationForm.getByRole("button", { name: "Apply change" }).click();
    await invitationForm.getByRole("status").filter({ hasText: "Invitation expiry saved." }).waitFor();
    assert.equal(settingValue, 336);
    assert.equal(settingVersion, 2);
    assert.deepEqual(observedMutations[0]?.body, { value: 336 });
    assert.equal(observedMutations[0]?.etag, '"setting-v1"');
    assert.equal(observedMutations[0]?.csrf, csrfToken);
    assert.equal(observedMutations[0]?.origin, origin);
    assert.match(observedMutations[0]?.cookie ?? "", /nuriteo_dev_session=admin/u);
    assert.deepEqual(observedPreviews[0], { value: 336 });

    settingValue = 400;
    settingVersion = 3;
    await expiry.fill("360");
    await invitationForm.getByRole("button", { name: "Review impact" }).click();
    await invitationForm.getByRole("button", { name: "Apply change" }).click();
    const conflict = invitationForm.getByRole("alert");
    await conflict.filter({ hasText: "changed elsewhere" }).waitFor();
    assert.equal(observedMutations[1]?.etag, '"setting-v2"');
    await conflict.getByRole("button", { name: "Reload latest" }).click();
    await assertEventually(async () => (await page.getByLabel("Invitation expiry").inputValue()) === "400");
    const refreshedInvitationForm = page.locator("form").filter({ hasText: "Invitation expiry" });
    await refreshedInvitationForm.getByRole("button", { name: "Reset to default" }).click();
    await refreshedInvitationForm.getByText("Impact reviewed").waitFor();
    assert.equal(await refreshedInvitationForm.getByLabel("Invitation expiry").inputValue(), "168");
    await refreshedInvitationForm.getByRole("button", { name: "Apply change" }).click();
    await refreshedInvitationForm.getByRole("status").filter({ hasText: "Invitation expiry saved." }).waitFor();
    assert.equal(settingValue, 168);

    await page.getByRole("navigation", { name: "Administration" })
      .getByRole("link", { name: "Operations" })
      .click();
    await page.getByRole("heading", { level: 1, name: "Operations" }).waitFor();
    assert.equal(await page.getByText("The object storage readiness probe failed.", { exact: true }).count(), 1);
    assert.equal(await page.getByText("1 GiB", { exact: true }).count(), 1);
    assert.equal(await page.getByText("1 MiB", { exact: true }).count(), 1);
    await page.getByRole("button", { name: "Download support bundle" }).waitFor();
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("button", { name: "Download support bundle" }).click()
    ]);
    assert.match(download.suggestedFilename(), /^nuriteo-support-.+\.json$/u);
    assert.equal(
      await page.getByRole("navigation", { name: "Administration" })
        .getByRole("link", { name: "Operations" })
        .getAttribute("aria-current"),
      "page"
    );
    assert.doesNotMatch(await page.locator("main").innerText(), /s3:\/\/|postgres:\/\/|object_key=/u);
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      true
    );

    const member = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await member.addCookies([{ name: "nuriteo_dev_session", value: "member", url: origin }]);
    const memberPage = await member.newPage();
    await memberPage.goto(`${origin}/admin/operations`, { waitUntil: "networkidle" });
    await memberPage.getByRole("heading", { name: "Administrator access required" }).waitFor();
    assert.equal(await memberPage.getByText("Core dependencies", { exact: true }).count(), 0);
    await Promise.all([admin.close(), member.close()]);
  } finally {
    await browser.close();
  }
} catch (error) {
  throw new Error(`admin settings browser journey failed; server output: ${serverOutput}`, {
    cause: error
  });
} finally {
  await stopChild(web);
  await new Promise<void>((resolve) => core.close(() => resolve()));
}

console.log("web admin settings and operations journey ok");

function settings() {
  return [
    setting(),
    valueSetting("audit.retention_days", 365),
    valueSetting("notifications.general_retention_days", 90),
    valueSetting("notifications.security_retention_days", 365),
    valueSetting("runtime.network.default", "browser_direct", "new_runtime"),
    valueSetting("security.mfa_enforcement", "off"),
    valueSetting("security.mfa_grace_period_days", 7),
    valueSetting("security.reauthentication_window_minutes", 30),
    valueSetting("tokens.default_expiry_days", 30),
    valueSetting("tokens.maximum_expiry_days", 365)
  ];
}

function setting() {
  return valueSetting("invitations.default_expiry_hours", settingValue, "live", settingVersion, 168);
}

function valueSetting(
  key: string,
  value: string | number | boolean | null,
  applyMode = "live",
  version = 1,
  defaultValue: string | number | boolean | null = value
) {
  const constraint = typeof value === "number"
    ? { kind: "unsigned_integer", minimum: 1, maximum: 10_000 }
    : typeof value === "boolean"
      ? { kind: "boolean" }
      : { kind: "enumeration", allowed: [String(value)] };
  return {
    key,
    value,
    defaultValue,
    version,
    applyMode,
    constraint,
    policyCategory: key.startsWith("smtp.") ? null : "identity"
  };
}

function currentUser(session: "admin" | "member") {
  const admin = session === "admin";
  return {
    user: {
      id: admin
        ? "0199ee6c-c777-7000-8000-000000010001"
        : "0199ee6c-c777-7000-8000-000000010101",
      email: admin ? "admin@example.test" : "member@example.test",
      display_name: admin ? "Instance Administrator" : "Team Member",
      is_instance_admin: admin
    },
    session: {
      id: admin
        ? "0199ee6c-c777-7000-8000-000000010002"
        : "0199ee6c-c777-7000-8000-000000010102",
      last_seen_at: "2026-10-07T00:00:00.000Z",
      idle_expires_at: "2026-10-07T01:00:00.000Z",
      absolute_expires_at: "2026-10-08T00:00:00.000Z"
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sendJson(response: http.ServerResponse, value: unknown): void {
  response.statusCode = 200;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(value));
}

function sendProblem(response: http.ServerResponse, status: number, code: string): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/problem+json");
  response.end(JSON.stringify({
    type: "about:blank",
    title: "Request rejected",
    status,
    detail: "The request could not be completed.",
    instance: "/api/v1/admin/settings",
    code,
    request_id: "admin-settings-browser",
    errors: []
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

async function assertEventually(predicate: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail("expected browser state was not observed");
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
