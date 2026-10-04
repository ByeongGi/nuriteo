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
const adminId = "0199ee6c-c777-7000-8000-000000008001";
const memberId = "0199ee6c-c777-7000-8000-000000008002";
const unknownId = "0199ee6c-c777-7000-8000-000000008003";
const duplicateMemberId = "0199ee6c-c777-7000-8000-000000008004";
const duplicateMemberTwoId = "0199ee6c-c777-7000-8000-000000008005";
const unavailableMemberId = "0199ee6c-c777-7000-8000-000000008006";
const unavailableMemberTwoId = "0199ee6c-c777-7000-8000-000000008007";
const organizationId = "0199ee6c-c777-7000-8000-000000008101";
const scopeId = "0199ee6c-c777-7000-8000-000000008102";
const personalScopeId = "0199ee6c-c777-7000-8000-000000008103";
const projectId = "0199ee6c-c777-7000-8000-000000008201";
const csrf = `nrt_csrf_${"p".repeat(43)}`;
const now = "2026-10-04T00:00:00.000Z";

assert.ok(fs.existsSync(serverEntry), "Run the production build before this browser check.");
fs.cpSync(path.join(webRoot, ".next/static"), path.join(standaloneWeb, ".next/static"), { force: true, recursive: true });

let project: ProjectRecord | undefined;
let version = 0;
let memberCanRead = false;
let unknownGrantAttempts = 0;
const roles: RoleRecord[] = [
  roleRecord(duplicateMemberId, "read"),
  roleRecord(duplicateMemberTwoId, "read"),
  roleRecord(unavailableMemberId, "read"),
  roleRecord(unavailableMemberTwoId, "read")
];
const core = http.createServer(async (request, response) => {
  const requestPath = request.url ?? "/";
  const session = request.headers.cookie?.includes("nuriteo_dev_session=member") ? "member" : request.headers.cookie?.includes("nuriteo_dev_session=admin") ? "admin" : undefined;
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-request-id", "project-browser-request");
  if (session === undefined) return problem(response, 401, "AUTHENTICATION_REQUIRED");
  if (request.method !== "GET") {
    assert.equal(request.headers["x-csrf-token"], csrf);
    assert.ok(request.headers.origin?.startsWith("http://127.0.0.1:"));
  }
  if (request.method === "GET" && requestPath === "/api/v1/me") return json(response, me(session));
  if (request.method === "GET" && requestPath === "/api/v1/me/workspaces") return json(response, { workspaces: workspaces(session) });
  if (request.method === "GET" && requestPath === `/api/v1/organizations/${organizationId}/members`) {
    assert.equal(session, "admin");
    return json(response, { items: [
      { userId: adminId, displayName: "Admin", role: "owner" },
      { userId: memberId, displayName: "Member", role: "member" },
      { userId: duplicateMemberId, displayName: "Twin", role: "member" },
      { userId: duplicateMemberTwoId, displayName: "Twin", role: "member" },
      { userId: unknownId, displayName: "Uncertain Member", role: "member" }
    ] });
  }

  if (request.method === "GET" && requestPath.startsWith(`/api/v1/workspaces/users/${adminId}/projects?`)) {
    return json(response, { items: [], nextCursor: null });
  }

  const collection = `/api/v1/workspaces/organizations/${organizationId}/projects`;
  if (request.method === "GET" && requestPath.startsWith(`${collection}?`)) {
    const state = new URL(requestPath, "http://core").searchParams.get("state") ?? "active";
    const visible = project !== undefined && (session === "admin" || memberCanRead) && (state === "all" || project.state === state);
    return json(response, { items: visible ? [project] : [], nextCursor: null });
  }
  if (request.method === "POST" && requestPath === collection) {
    assert.equal(session, "admin");
    const body = await bodyOf(request);
    version = 1;
    project = record(String(body.name), String(body.slug), "active");
    response.setHeader("etag", etag());
    response.setHeader("location", `${collection}/${projectId}`);
    return json(response, project, 201);
  }
  const item = `${collection}/${projectId}`;
  if (request.method === "GET" && requestPath === item) {
    if (project === undefined) return problem(response, 404, "PROJECT_NOT_FOUND");
    if (session !== "admin" && !memberCanRead) return problem(response, 403, "FORBIDDEN");
    response.setHeader("etag", etag());
    return json(response, project);
  }
  if (request.method === "PATCH" && requestPath === item) {
    assertProjectMutation(request, session);
    const body = await bodyOf(request);
    if (body.name === "Stale attempt") return problem(response, 412, "PROJECT_VERSION_STALE");
    version += 1;
    project = record(String(body.name), project!.slug, project!.state);
    response.setHeader("etag", etag());
    return json(response, project);
  }
  if (request.method === "POST" && requestPath === `${item}/archive`) return lifecycle(request, response, session, "archived");
  if (request.method === "POST" && requestPath === `${item}/restore`) return lifecycle(request, response, session, "active");
  if (request.method === "DELETE" && requestPath === item) {
    assertProjectMutation(request, session);
    const body = await bodyOf(request);
    assert.equal(body.name, project?.name);
    project = undefined;
    response.statusCode = 204;
    response.end();
    return;
  }
  if (request.method === "GET" && requestPath.startsWith(`${item}/roles?`)) {
    if (session !== "admin") return problem(response, 404, "PROJECT_NOT_FOUND");
    return json(response, { items: roles, nextCursor: null });
  }
  if (request.method === "POST" && requestPath === `${item}/roles`) {
    assertProjectMutation(request, session);
    const body = await bodyOf(request);
    if (body.userId === unknownId && unknownGrantAttempts++ === 0) return problem(response, 503, "COMMIT_OUTCOME_UNKNOWN");
    version += 1;
    project = record(project!.name, project!.slug, project!.state);
    const role = roleRecord(String(body.userId), String(body.role));
    roles.push(role);
    if (body.userId === memberId) memberCanRead = true;
    response.setHeader("etag", etag());
    return json(response, { changed: true, grant: role, projectVersion: version }, 201);
  }
  const direct = requestPath.match(new RegExp(`^${item}/roles/([^/]+)$`, "u"));
  if (direct?.[1] && request.method === "PATCH") {
    assertProjectMutation(request, session);
    const body = await bodyOf(request);
    const role = roles.find((entry) => entry.userId === direct[1]);
    assert.ok(role);
    version += 1;
    project = record(project!.name, project!.slug, project!.state);
    role.role = String(body.role);
    role.version += 1;
    response.setHeader("etag", etag());
    return json(response, { changed: true, grant: role, projectVersion: version });
  }
  if (direct?.[1] && request.method === "DELETE") {
    assertProjectMutation(request, session);
    const index = roles.findIndex((entry) => entry.userId === direct[1]);
    const changed = index >= 0;
    if (changed) {
      roles.splice(index, 1);
      version += 1;
      project = record(project!.name, project!.slug, project!.state);
      if (direct[1] === memberId) memberCanRead = false;
    }
    response.setHeader("etag", etag());
    return json(response, { changed, grant: null, projectVersion: version });
  }
  return problem(response, 404, "NOT_FOUND");
});

await listen(core);
const coreAddress = core.address();
assert.ok(coreAddress && typeof coreAddress !== "string");
const standalone = await startWeb(coreAddress.port);
try {
  const browser = await chromium.launch({ headless: true });
  try {
    const adminContext = await contextFor(browser, standalone.origin, "admin");
    const memberContext = await contextFor(browser, standalone.origin, "member");
    const admin = await adminContext.newPage();
    const member = await memberContext.newPage();
    const projectsUrl = `${standalone.origin}/projects?workspace=${scopeId}&state=active`;
    await Promise.all([admin.goto(projectsUrl, { waitUntil: "networkidle" }), member.goto(projectsUrl, { waitUntil: "networkidle" })]);
    assert.equal(await member.getByText("Select a Project").count(), 1);

    await admin.getByLabel("Slug").fill("alpha-project");
    await admin.getByLabel("Name", { exact: true }).fill("Alpha Project");
    const createResponse = admin.waitForResponse((response) => response.request().method() === "POST" && response.url().endsWith("/projects"));
    await admin.getByRole("button", { name: "Create Project" }).click();
    assert.equal((await createResponse).status(), 201);
    await admin.getByRole("heading", { name: "Alpha Project", exact: true }).waitFor();
    assert.equal(new URL(admin.url()).searchParams.get("project"), projectId);

    await admin.getByRole("link", { name: "Admin Personal" }).click();
    await admin.getByText("Select a Project").waitFor();
    assert.equal(await admin.getByRole("heading", { name: "Alpha Project", exact: true }).count(), 0);
    await admin.getByRole("link", { name: "Alpha Organization" }).click();
    await admin.getByText("Alpha Project", { exact: true }).click();
    await admin.getByRole("heading", { name: "Alpha Project", exact: true }).waitFor();

    await admin.getByLabel("Project name").fill("Stale attempt");
    await admin.getByRole("button", { name: "Save name" }).click();
    await admin.getByText(/This Project changed/u).waitFor();
    assert.equal(await admin.getByRole("button", { name: "Reload latest Project" }).count(), 1);
    await admin.getByLabel("Project name").fill("Renamed Project");
    await admin.getByRole("button", { name: "Save name" }).click();
    await admin.getByRole("heading", { name: "Renamed Project", exact: true }).waitFor();

    await admin.getByRole("button", { name: "Archive" }).click();
    await admin.getByRole("button", { name: "Restore" }).waitFor();
    assert.equal(await admin.locator(".project-sidebar .record-list").getByText("Renamed Project", { exact: true }).count(), 0);
    await admin.getByRole("button", { name: "Restore" }).click();
    await admin.getByRole("button", { name: "Archive" }).waitFor();
    await admin.locator(".project-sidebar .record-list").getByText("Renamed Project", { exact: true }).waitFor();

    const memberSelect = admin.getByLabel("Organization member", { exact: true });
    assert.equal(await admin.getByLabel("Organization member user ID").count(), 0);
    assert.equal(await memberSelect.count(), 1, await admin.locator("body").innerText());
    assert.notEqual(await memberSelect.locator(`option[value="${adminId}"]`).getAttribute("disabled"), null);
    assert.equal(await memberSelect.locator(`option[value="${memberId}"]`).textContent(), "Member · Organization member");
    assert.equal(await memberSelect.locator(`option[value="${duplicateMemberId}"]`).textContent(), "Twin · Organization member");
    assert.notEqual(await memberSelect.locator(`option[value="${duplicateMemberId}"]`).getAttribute("disabled"), null);
    assert.notEqual(await memberSelect.locator(`option[value="${duplicateMemberTwoId}"]`).getAttribute("disabled"), null);
    await admin.getByText(/same display name/u).waitFor();
    await revokeNonActionableGrant(
      admin,
      roles,
      duplicateMemberTwoId,
      "Twin · Organization member · Ambiguous member · Grant 2 of 2"
    );
    await revokeNonActionableGrant(
      admin,
      roles,
      duplicateMemberId,
      "Twin · Organization member · Ambiguous member · Grant 1 of 1"
    );
    await revokeNonActionableGrant(
      admin,
      roles,
      unavailableMemberTwoId,
      "Unavailable Organization member · Grant 2 of 2"
    );
    await revokeNonActionableGrant(
      admin,
      roles,
      unavailableMemberId,
      "Unavailable Organization member · Grant 1 of 1"
    );
    await memberSelect.selectOption({ label: "Uncertain Member · Organization member" });
    await admin.getByRole("button", { name: "Grant role" }).click();
    await admin.getByText(/may have completed/u).waitFor();
    await memberSelect.selectOption(memberId);
    await admin.getByRole("button", { name: "Grant role" }).click();
    const memberLabel = "Member · Organization member";
    await admin.locator(".project-detail .record-list").getByText(memberLabel, { exact: true }).waitFor();
    await admin.getByRole("status").getByText("Member now has read access.", { exact: true }).waitFor();
    assert.equal(await memberSelect.inputValue(), "");
    assert.notEqual(await memberSelect.locator(`option[value="${memberId}"]`).getAttribute("disabled"), null);

    const changeResponse = admin.waitForResponse((response) => response.request().method() === "PATCH" && response.url().endsWith(`/roles/${memberId}`));
    await admin.getByLabel(`Role for ${memberLabel}`).selectOption("write");
    assert.equal((await changeResponse).status(), 200);
    assert.equal(roles.find((entry) => entry.userId === memberId)?.role, "write");

    await member.reload({ waitUntil: "networkidle" });
    await member.getByText("Renamed Project", { exact: true }).click();
    await member.getByRole("heading", { name: "Renamed Project", exact: true }).waitFor();
    assert.equal(await member.getByText(/Only Organization Owners/u).count(), 1);

    const memberGrant = admin.locator(".project-detail .record-list li").filter({
      has: admin.getByText(memberLabel, { exact: true })
    });
    const revokeResponsePromise = admin.waitForResponse((response) => response.request().method() === "DELETE" && response.url().endsWith(`/roles/${memberId}`));
    await memberGrant.getByRole("button", { name: "Revoke" }).click();
    const revokeResponse = await revokeResponsePromise;
    const revokedEtag = revokeResponse.headers().etag;
    assert.ok(revokedEtag);
    const revoked = await revokeResponse.json() as { changed: boolean; projectVersion: number };
    assert.equal(revoked.changed, true);
    await memberGrant.waitFor({ state: "detached" });
    assert.equal(await memberSelect.locator(`option[value="${memberId}"]`).getAttribute("disabled"), null);

    const noOp = await admin.evaluate(async ({ csrf, etag, organizationId, projectId, userId }) => {
      const response = await fetch(`/api/v1/workspaces/organizations/${organizationId}/projects/${projectId}/roles/${userId}`, {
        headers: { "if-match": etag, "x-csrf-token": csrf },
        method: "DELETE"
      });
      return { body: await response.json() as { changed: boolean; projectVersion: number }, etag: response.headers.get("etag"), status: response.status };
    }, { csrf, etag: revokedEtag, organizationId, projectId, userId: memberId });
    assert.equal(noOp.status, 200);
    assert.equal(noOp.body.changed, false);
    assert.equal(noOp.body.projectVersion, revoked.projectVersion);
    assert.equal(noOp.etag, revokedEtag);

    for (const userId of [memberId, unknownId]) {
      await memberSelect.selectOption(userId);
      const grantResponse = admin.waitForResponse((response) => response.request().method() === "POST" && response.url().endsWith("/roles"));
      await admin.getByRole("button", { name: "Grant role" }).click();
      assert.equal((await grantResponse).status(), 201);
      const expectedLabel = userId === unknownId
        ? "Uncertain Member · Organization member"
        : "Member · Organization member";
      await admin.locator(".project-detail .record-list").getByText(expectedLabel, { exact: true }).waitFor();
    }
    await admin.getByText("No Organization members are available for a direct role.").waitFor();
    assert.equal(await memberSelect.isDisabled(), true);
    assert.equal(await admin.getByRole("button", { name: "Grant role" }).isDisabled(), true);

    const currentMemberGrant = admin.locator(".project-detail .record-list li").filter({
      has: admin.getByText(memberLabel, { exact: true })
    });
    const [finalRevokeResponse] = await Promise.all([
      admin.waitForResponse((response) => response.request().method() === "DELETE" && response.url().endsWith(`/roles/${memberId}`)),
      currentMemberGrant.getByRole("button", { name: "Revoke" }).click()
    ]);
    assert.equal(finalRevokeResponse.status(), 200);
    await currentMemberGrant.waitFor({ state: "detached" });
    assert.equal(await memberSelect.locator(`option[value="${memberId}"]`).getAttribute("disabled"), null);

    await member.goto(projectsUrl, { waitUntil: "networkidle" });
    assert.equal(await member.getByText("Renamed Project", { exact: true }).count(), 0);
    await member.goto(`${projectsUrl}&project=${projectId}`, { waitUntil: "networkidle" });
    assert.equal(await member.getByText("Renamed Project", { exact: true }).count(), 0);

    await admin.getByRole("link", { name: "all", exact: true }).click();
    await admin.locator(".project-sidebar .record-list").getByText("Renamed Project", { exact: true }).click();
    await admin.getByRole("button", { name: "Archive" }).click();
    await admin.locator(".project-sidebar .record-list li", { hasText: "Renamed Project" }).getByText(/archived/u).waitFor();
    await admin.getByLabel(/Type Renamed Project to delete/u).fill("Renamed Project");
    await admin.getByRole("button", { name: "Delete Project" }).click();
    await admin.waitForURL((url) => !url.searchParams.has("project"));
    assert.equal(project, undefined);
    assert.equal(memberCanRead, false);
  } finally {
    await browser.close();
  }
} finally {
  await stopChild(standalone.child);
  await new Promise<void>((resolve) => core.close(() => resolve()));
}

async function revokeNonActionableGrant(
  page: import("@playwright/test").Page,
  currentRoles: readonly RoleRecord[],
  userId: string,
  label: string
): Promise<void> {
  const grant = page.locator(".project-detail .record-list li").filter({
    has: page.getByText(label, { exact: true })
  });
  assert.equal(await grant.getByRole("combobox").isDisabled(), true);
  const revoke = grant.getByRole("button", { name: `Revoke ${label}`, exact: true });
  assert.equal(await revoke.isEnabled(), true);
  const [response] = await Promise.all([
    page.waitForResponse((candidate) =>
      candidate.request().method() === "DELETE" && candidate.url().endsWith(`/roles/${userId}`)
    ),
    revoke.click()
  ]);
  assert.equal(response.status(), 200);
  await grant.waitFor({ state: "detached" });
  assert.equal(currentRoles.some((role) => role.userId === userId), false);
}

interface ProjectRecord { archivedAt: string | null; createdAt: string; id: string; name: string; ownerId: string; ownerType: "organization"; slug: string; state: "active" | "archived"; storageScopeId: string; updatedAt: string; version: number }
interface RoleRecord { createdAt: string; organizationId: string; projectId: string; role: string; updatedAt: string; userId: string; version: number }
function record(name: string, slug: string, state: "active" | "archived"): ProjectRecord { return { archivedAt: state === "archived" ? now : null, createdAt: now, id: projectId, name, ownerId: organizationId, ownerType: "organization", slug, state, storageScopeId: scopeId, updatedAt: now, version }; }
function roleRecord(userId: string, role: string): RoleRecord { return { createdAt: now, organizationId, projectId, role, updatedAt: now, userId, version: 1 }; }
function etag(): string { return `"project-v${version}"`; }
function workspaces(session: "admin" | "member") { const shared = { ownerType: "organization", ownerId: organizationId, displayLabel: "Alpha Organization", storageScopeId: scopeId }; return session === "admin" ? [{ ownerType: "user", ownerId: adminId, displayLabel: "Admin Personal", storageScopeId: personalScopeId }, shared] : [shared]; }
function me(session: "admin" | "member") { const admin = session === "admin"; return { user: { id: admin ? adminId : memberId, email: `${session}@example.test`, display_name: admin ? "Admin" : "Member", is_instance_admin: admin }, session: { id: admin ? "0199ee6c-c777-7000-8000-000000008011" : "0199ee6c-c777-7000-8000-000000008012", last_seen_at: now, idle_expires_at: "2026-10-04T01:00:00.000Z", absolute_expires_at: "2026-10-05T00:00:00.000Z" } }; }
function assertProjectMutation(request: http.IncomingMessage, session: string) { assert.equal(session, "admin"); assert.equal(request.headers["if-match"], etag()); assert.ok(project); }
function lifecycle(request: http.IncomingMessage, response: http.ServerResponse, session: string, state: "active" | "archived") { assertProjectMutation(request, session); version += 1; project = record(project!.name, project!.slug, state); response.setHeader("etag", etag()); return json(response, project); }
function json(response: http.ServerResponse, value: unknown, status = 200) { response.statusCode = status; response.setHeader("content-type", "application/json"); response.end(JSON.stringify(value)); }
function problem(response: http.ServerResponse, status: number, code: string) { response.statusCode = status; response.setHeader("content-type", "application/problem+json"); response.end(JSON.stringify({ type: "about:blank", title: "Rejected", status, detail: "The request could not be completed.", instance: "/api/v1", code, request_id: "project-browser-request", errors: [] })); }
async function bodyOf(request: http.IncomingMessage): Promise<Record<string, unknown>> { const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)); return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>; }
async function listen(server: http.Server): Promise<void> { await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); }); }
async function reservePort(): Promise<number> { const server = http.createServer(); await listen(server); const address = server.address(); assert.ok(address && typeof address !== "string"); await new Promise<void>((resolve) => server.close(() => resolve())); return address.port; }
async function startWeb(corePort: number) { for (let attempt = 0; attempt < 5; attempt += 1) { const port = await reservePort(); const origin = `http://127.0.0.1:${port}`; const child = spawn(process.execPath, [serverEntry], { cwd: standaloneWeb, env: { ...process.env, HOSTNAME: "127.0.0.1", NURITEO_INTERNAL_API_URL: `http://127.0.0.1:${corePort}`, PORT: String(port) }, stdio: "ignore" }); try { await ready(origin, child); return { child, origin }; } catch { await stopChild(child); } } throw new Error("standalone Web did not bind after bounded retries"); }
async function ready(origin: string, child: ReturnType<typeof spawn>) { const deadline = Date.now() + 15_000; while (Date.now() < deadline) { if (child.exitCode !== null) throw new Error("standalone exited"); try { const response = await fetch(`${origin}/sign-in`, { redirect: "manual" }); if (response.status < 500) return; } catch { /* starting */ } await new Promise((resolve) => setTimeout(resolve, 100)); } throw new Error("standalone readiness timed out"); }
async function stopChild(child: ReturnType<typeof spawn>) { if (child.exitCode !== null) return; child.kill("SIGTERM"); const exited = new Promise<boolean>((resolve) => child.once("exit", () => resolve(true))); if (await Promise.race([exited, new Promise<false>((resolve) => setTimeout(() => resolve(false), 2_000))])) return; child.kill("SIGKILL"); await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 1_000))]); }
async function contextFor(browser: import("@playwright/test").Browser, origin: string, session: string) { const context = await browser.newContext(); await context.addCookies([{ name: "nuriteo_dev_session", value: session, url: origin }, { name: "nuriteo_dev_csrf", value: csrf, url: origin }]); return context; }
