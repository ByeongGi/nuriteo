import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "@playwright/test";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const nextDirectory = process.env.NURITEO_NEXT_DIST_DIR ?? ".next";
const standaloneWeb = path.join(webRoot, nextDirectory, "standalone/apps/web");
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
fs.cpSync(path.join(webRoot, nextDirectory, "static"), path.join(standaloneWeb, ".next/static"), { force: true, recursive: true });

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
  if (request.method === "GET" && requestPath === "/api/v1/mfa") return json(response, {
    localAccount: true,
    enrolled: true,
    pendingEnrollment: false,
    recoveryCodesRemaining: 8,
    policyMode: "off",
    gracePeriodDays: 7,
    required: false,
    deadlineAt: null,
    restricted: false,
    notificationState: "none"
  });
  if (request.method === "GET" && requestPath.startsWith("/api/v1/notifications")) return json(response, { items: [], nextCursor: null, unreadCount: 0 });
  if (request.method === "GET" && requestPath === "/api/v1/maintenance") return json(response, { readOnly: false, phase: "idle" });
  if (request.method === "GET" && requestPath === "/api/v1/me/workspaces") return json(response, { workspaces: workspaces(session) });
  if (request.method === "GET" && requestPath === `/api/v1/organizations/${organizationId}/members`) {
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
    const projectsPath = `/workspaces/${scopeId}`;
    const projectBasePath = `${projectsPath}/projects`;
    const projectSettingsPath = `${projectBasePath}/${projectId}/settings/general`;
    const projectStudioPath = `${projectBasePath}/${projectId}/studio`;
    const projectsUrl = `${standalone.origin}${projectsPath}?state=active`;
    await Promise.all([admin.goto(projectsUrl, { waitUntil: "networkidle" }), member.goto(projectsUrl, { waitUntil: "networkidle" })]);
    assert.equal(await member.getByText("프로젝트를 선택하세요").count(), 1);

    await admin.goto(`${standalone.origin}/projects?workspace=${scopeId}&state=active`, { waitUntil: "networkidle" });
    assertCanonicalLocation(admin, projectsPath, "active");
    await admin.goto(`${standalone.origin}/workspaces/${scopeId}/projects?state=active`, { waitUntil: "networkidle" });
    assertCanonicalLocation(admin, projectsPath, "active");

    await admin.getByRole("link", { name: "새 프로젝트" }).click();
    await admin.getByLabel("슬러그").fill("alpha-project");
    await admin.getByLabel("프로젝트 이름", { exact: true }).fill("Alpha Project");
    const createResponse = admin.waitForResponse((response) => response.request().method() === "POST" && response.url().endsWith("/projects"));
    await admin.getByRole("button", { name: "프로젝트 만들기" }).click();
    assert.equal((await createResponse).status(), 201);
    await admin.waitForURL((url) => url.pathname === projectStudioPath);
    assertCanonicalLocation(admin, projectStudioPath);
    await admin.getByText("Alpha Project", { exact: true }).first().waitFor();
    assert.equal(await admin.getByLabel("프로젝트 이름", { exact: true }).count(), 0, "Studio must not expose project settings fields");

    await admin.goto(`${standalone.origin}/projects/${projectId}/studio?workspace=${scopeId}`, { waitUntil: "networkidle" });
    assertCanonicalLocation(admin, projectStudioPath);
    await admin.goto(`${standalone.origin}/workspaces/${scopeId}/projects/${projectId}/studio`, { waitUntil: "networkidle" });
    assertCanonicalLocation(admin, projectStudioPath);
    await admin.goto(`${standalone.origin}${projectSettingsPath}`, { waitUntil: "networkidle" });
    assertCanonicalLocation(admin, projectSettingsPath);

    await admin.goto(`${standalone.origin}/projects/${projectId}/settings?workspace=${scopeId}&state=active`, { waitUntil: "networkidle" });
    assertCanonicalLocation(admin, projectSettingsPath, "active");
    await admin.goto(`${standalone.origin}/workspaces/${scopeId}/projects/${projectId}/settings?state=active`, { waitUntil: "networkidle" });
    assertCanonicalLocation(admin, projectSettingsPath);
    await admin.setViewportSize({ width: 390, height: 844 });
    assert.equal(await admin.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    const mobileStudioBounds = await admin.getByRole("link", { name: "Studio에서 열기" }).boundingBox();
    assert.ok(mobileStudioBounds, "the Project Studio action must remain available on mobile");
    await admin.setViewportSize({ width: 1600, height: 1100 });

    await admin.goto(`${standalone.origin}/workspaces/${personalScopeId}?state=active`, { waitUntil: "networkidle" });
    assert.equal(await admin.getByRole("heading", { name: "Alpha Project", exact: true }).count(), 0);
    await admin.goto(projectsUrl, { waitUntil: "networkidle" });
    await admin.getByText("Alpha Project", { exact: true }).click();
    await admin.waitForURL((url) => url.pathname === projectStudioPath);
    assertCanonicalLocation(admin, projectStudioPath);
    await admin.goto(`${standalone.origin}${projectSettingsPath}`, { waitUntil: "networkidle" });
    assertCanonicalLocation(admin, projectSettingsPath);
    await admin.getByRole("heading", { name: "일반 설정", exact: true }).waitFor();

    const projectNameInput = admin.getByLabel("프로젝트 이름");
    await projectNameInput.fill("Stale attempt");
    await admin.getByRole("button", { name: "이름 저장" }).click();
    await admin.getByText(/프로젝트 정보가 변경되었습니다/u).waitFor();
    await projectNameInput.fill("Renamed Project");
    await admin.getByRole("button", { name: "이름 저장" }).click();
    await admin.getByRole("status").getByText("프로젝트 이름을 저장했습니다.").waitFor();
    await admin.getByRole("link", { name: "위험 영역" }).click();
    await admin.getByRole("heading", { level: 1, name: "위험 영역", exact: true }).waitFor();
    await admin.getByRole("button", { name: "프로젝트 보관" }).click();
    await admin.getByRole("button", { name: "프로젝트 복원" }).waitFor();
    await admin.getByRole("button", { name: "프로젝트 복원" }).click();
    await admin.getByRole("button", { name: "프로젝트 보관" }).waitFor();
    await admin.getByRole("button", { name: "프로젝트 삭제" }).click();
    await admin.getByRole("alertdialog").waitFor();
    assert.equal(await admin.getByLabel(/삭제하려면/u).count(), 0, "project deletion must not require typing the project name");
    await admin.getByRole("alertdialog").getByRole("button", { name: "프로젝트 삭제" }).click();
    await admin.waitForURL((url) => url.pathname === projectsPath);
    assertCanonicalLocation(admin, projectsPath, "active");
    assert.equal(project, undefined);
    assert.equal(memberCanRead, false);
  } finally {
    await browser.close();
  }
} finally {
  await stopChild(standalone.child);
  await new Promise<void>((resolve) => core.close(() => resolve()));
}

interface ProjectRecord { archivedAt: string | null; createdAt: string; id: string; name: string; ownerId: string; ownerType: "organization"; slug: string; state: "active" | "archived"; storageScopeId: string; templateId: "vite-react"; updatedAt: string; version: number }
interface RoleRecord { createdAt: string; organizationId: string; projectId: string; role: string; updatedAt: string; userId: string; version: number }
function record(name: string, slug: string, state: "active" | "archived"): ProjectRecord { return { archivedAt: state === "archived" ? now : null, createdAt: now, id: projectId, name, ownerId: organizationId, ownerType: "organization", slug, state, storageScopeId: scopeId, templateId: "vite-react", updatedAt: now, version }; }
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

function assertCanonicalLocation(page: import("@playwright/test").Page, pathname: string, state?: string): void {
  const current = new URL(page.url());
  assert.equal(current.pathname, pathname);
  assert.equal(current.searchParams.has("workspace"), false, "canonical IA must not leak workspace as a query parameter");
  assert.equal(current.searchParams.has("canonical"), false, "internal canonical markers must not leak into the browser URL");
  assert.equal(current.searchParams.get("state"), state ?? null);
}
