import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "@playwright/test";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const standaloneWeb = path.join(webRoot, ".next/standalone/apps/web");
const serverEntry = path.join(standaloneWeb, "server.js");
const ownerId = "0199ee6c-c777-7000-8000-000000012001";
const memberId = "0199ee6c-c777-7000-8000-000000012002";
const organizationId = "0199ee6c-c777-7000-8000-000000012101";
const teamId = "0199ee6c-c777-7000-8000-000000012201";
const projectId = "0199ee6c-c777-7000-8000-000000012301";
const scopeId = "0199ee6c-c777-7000-8000-000000012401";
const csrf = `nrt_csrf_${"t".repeat(43)}`;
const now = "2026-10-07T00:00:00.000Z";

assert.ok(fs.existsSync(serverEntry), "Run the production build before this browser check.");
fs.cpSync(path.join(webRoot, ".next/static"), path.join(standaloneWeb, ".next/static"), {
  force: true,
  recursive: true
});

let team: TeamRecord | undefined;
let teamMember: TeamMemberRecord | undefined;
let projectRole: TeamProjectRoleRecord | undefined;
let staleRenamePending = true;
let memberEffectiveProjectReads = 0;
const observedMutations: Array<{
  csrf: string | undefined;
  ifMatch: string | undefined;
  origin: string | undefined;
  path: string;
}> = [];

const core = http.createServer(async (request, response) => {
  const requestPath = request.url ?? "/";
  const session = sessionFrom(request.headers.cookie);
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-request-id", "team-browser-request");
  if (session === undefined) return problem(response, 401, "AUTHENTICATION_REQUIRED");

  if (request.method !== "GET") {
    observedMutations.push({
      csrf: header(request, "x-csrf-token"),
      ifMatch: header(request, "if-match"),
      origin: header(request, "origin"),
      path: requestPath
    });
    assert.equal(header(request, "x-csrf-token"), csrf);
    assert.match(header(request, "origin") ?? "", /^http:\/\/127\.0\.0\.1:\d+$/u);
  }

  if (request.method === "GET" && requestPath === "/api/v1/me") return json(response, currentUser(session));
  if (request.method === "GET" && requestPath === `/api/v1/organizations/${organizationId}`) {
    response.setHeader("etag", '"org-v1"');
    return json(response, organization());
  }
  if (request.method === "GET" && requestPath === `/api/v1/organizations/${organizationId}/members`) {
    return json(response, { items: organizationMembers() });
  }

  const collection = `/api/v1/organizations/${organizationId}/teams`;
  if (request.method === "GET" && requestPath.startsWith(`${collection}?`)) {
    const visible = team !== undefined && (session === "owner" || teamMember !== undefined);
    return json(response, { items: visible ? [team] : [], nextCursor: null });
  }
  if (request.method === "POST" && requestPath === collection) {
    assert.equal(session, "owner");
    const body = await bodyOf(request);
    assert.deepEqual(body, { displayName: "Platform", slug: "platform" });
    team = teamRecord("Platform", 1);
    response.setHeader("etag", '"team-v1"');
    response.setHeader("location", `${collection}/${teamId}`);
    return json(response, team, 201);
  }

  const item = `${collection}/${teamId}`;
  if (request.method === "GET" && requestPath === item) {
    if (team === undefined || (session === "member" && teamMember === undefined)) {
      return problem(response, 404, "TEAM_NOT_FOUND");
    }
    response.setHeader("etag", `"team-v${team.version}"`);
    return json(response, team);
  }
  if (request.method === "PATCH" && requestPath === item) {
    assert.equal(session, "owner");
    assert.equal(header(request, "if-match"), '"team-v1"');
    if (staleRenamePending) {
      staleRenamePending = false;
      return problem(response, 412, "TEAM_VERSION_STALE");
    }
    const body = await bodyOf(request);
    team = teamRecord(String(body.displayName), 2);
    response.setHeader("etag", '"team-v2"');
    return json(response, team);
  }

  const membersPath = `${item}/members`;
  if (request.method === "GET" && requestPath.startsWith(`${membersPath}?`)) {
    return json(response, { items: teamMember === undefined ? [] : [teamMember], nextCursor: null });
  }
  if (request.method === "POST" && requestPath === membersPath) {
    assert.equal(session, "owner");
    const body = await bodyOf(request);
    assert.deepEqual(body, { role: "member", userId: memberId });
    teamMember = teamMemberRecord();
    response.setHeader("etag", '"team-member-v1"');
    return json(response, teamMember, 201);
  }

  const rolesPath = `${item}/project-roles`;
  if (request.method === "GET" && requestPath.startsWith(`${rolesPath}?`)) {
    return json(response, { items: projectRole === undefined ? [] : [projectRole], nextCursor: null });
  }
  if (request.method === "POST" && requestPath === rolesPath) {
    assert.equal(session, "owner");
    const body = await bodyOf(request);
    assert.deepEqual(body, { projectId, role: "write" });
    projectRole = teamProjectRoleRecord();
    response.setHeader("etag", '"team-project-role-v1"');
    return json(response, projectRole, 201);
  }

  const projects = `/api/v1/workspaces/organizations/${organizationId}/projects`;
  if (request.method === "GET" && requestPath.startsWith(`${projects}?`)) {
    assert.equal(session, "owner");
    return json(response, { items: [project()], nextCursor: null });
  }
  if (request.method === "GET" && requestPath === `${projects}/${projectId}`) {
    if (session === "member") {
      if (teamMember === undefined || projectRole === undefined) return problem(response, 403, "FORBIDDEN");
      memberEffectiveProjectReads += 1;
    }
    response.setHeader("etag", '"project-v1"');
    return json(response, project());
  }

  return problem(response, 404, "NOT_FOUND");
});

await listen(core);
const address = core.address();
assert.ok(address && typeof address !== "string");
const web = await startWeb(address.port);
try {
  const browser = await chromium.launch({ headless: true });
  try {
    const ownerContext = await contextFor(browser, web.origin, "owner", "light", { width: 1280, height: 900 });
    const memberContext = await contextFor(browser, web.origin, "member", "dark", { width: 390, height: 844 });
    const owner = await ownerContext.newPage();
    const member = await memberContext.newPage();
    const teamsUrl = `${web.origin}/organizations/${organizationId}/teams`;

    await owner.goto(teamsUrl, { waitUntil: "networkidle" });
    await owner.getByRole("heading", { level: 1, name: "Teams" }).waitFor();
    assert.equal(await owner.locator("html").getAttribute("data-theme-mode"), "light");
    await owner.getByLabel("Slug").fill("platform");
    await owner.getByLabel("Display name", { exact: true }).fill("Platform");
    const [createResponse] = await Promise.all([
      owner.waitForResponse((candidate) => candidate.request().method() === "POST" && candidate.url().endsWith("/teams")),
      owner.getByRole("button", { name: "Create Team" }).click()
    ]);
    assert.equal(createResponse.status(), 201);
    await owner.getByRole("heading", { level: 2, name: "Platform" }).waitFor();
    assert.equal(new URL(owner.url()).searchParams.get("team"), teamId);

    await owner.getByLabel("Organization member").selectOption(memberId);
    const [memberResponse] = await Promise.all([
      owner.waitForResponse((candidate) => candidate.request().method() === "POST" && candidate.url().endsWith("/members")),
      owner.getByRole("button", { name: "Add member" }).click()
    ]);
    assert.equal(memberResponse.status(), 201);
    await owner.getByRole("status").getByText("Team member added.").waitFor();

    await owner.locator('select[name="projectId"]').selectOption(projectId);
    await owner.locator('select[name="role"]').last().selectOption("write");
    const [grantResponse] = await Promise.all([
      owner.waitForResponse((candidate) => candidate.request().method() === "POST" && candidate.url().endsWith("/project-roles")),
      owner.getByRole("button", { name: "Grant access" }).click()
    ]);
    assert.equal(grantResponse.status(), 201);
    await owner.getByRole("status").getByText("Project access granted to the Team.").waitFor();

    await owner.getByRole("region", { name: "Profile" })
      .getByLabel("Display name")
      .fill("Platform Engineering");
    const [staleResponse] = await Promise.all([
      owner.waitForResponse((candidate) => candidate.request().method() === "PATCH" && candidate.url().endsWith(`/teams/${teamId}`)),
      owner.getByRole("button", { name: "Save name" }).click()
    ]);
    assert.equal(staleResponse.status(), 412);
    await owner.getByRole("alert").getByText(/changed or the server outcome is unknown/u).waitFor();
    await owner.getByRole("button", { name: "Reload latest Team" }).click();
    await owner.locator(".team-feedback").waitFor({ state: "detached" });
    await owner.getByRole("heading", { level: 2, name: "Platform" }).waitFor();

    await member.goto(`${teamsUrl}?team=${teamId}`, { waitUntil: "networkidle" });
    await member.getByRole("heading", { level: 2, name: "Platform" }).waitFor();
    assert.equal(await member.locator("html").getAttribute("data-theme-mode"), "dark");
    await member.getByText("Your Team membership is read-only.", { exact: true }).waitFor();
    await member.getByText("Only Organization Owners can change Team Project grants.", { exact: true }).waitFor();
    assert.equal(await member.getByRole("button", { name: "Create Team" }).count(), 0);
    assert.equal(await member.getByRole("button", { name: "Grant access" }).count(), 0);
    assert.equal(await member.getByText("Atlas", { exact: true }).count(), 1);
    assert.equal(await member.getByText("write", { exact: true }).count(), 1);
    assert.equal(memberEffectiveProjectReads, 1, "member Project projection must be authorized by the Team grant");
    assert.equal(
      await member.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      true,
      "390px Team console must not overflow horizontally"
    );

    assert.ok(observedMutations.every((entry) => entry.csrf === csrf));
    assert.ok(observedMutations.every((entry) => /^http:\/\/127\.0\.0\.1:\d+$/u.test(entry.origin ?? "")));
    assert.equal(observedMutations.some((entry) => entry.path.endsWith(`/teams/${teamId}`) && entry.ifMatch === '"team-v1"'), true);
    await Promise.all([ownerContext.close(), memberContext.close()]);
  } finally {
    await browser.close();
  }
} catch (error) {
  throw new Error(`Team browser journey failed; Web log: ${web.output()}`, { cause: error });
} finally {
  await stopChild(web.child);
  await new Promise<void>((resolve) => core.close(() => resolve()));
}

console.log("TEAM-003 owner/member production browser journey ok");

type Session = "member" | "owner";
interface TeamRecord { createdAt: string; displayName: string; id: string; organizationId: string; slug: string; updatedAt: string; version: number }
interface TeamMemberRecord { createdAt: string; organizationId: string; role: "member"; teamId: string; updatedAt: string; userId: string; version: number }
interface TeamProjectRoleRecord { createdAt: string; organizationId: string; projectId: string; role: "write"; teamId: string; updatedAt: string; version: number }

function currentUser(session: Session) { const owner = session === "owner"; return { user: { id: owner ? ownerId : memberId, email: `${session}@example.test`, display_name: owner ? "Owner" : "Member", is_instance_admin: false }, session: { id: owner ? "0199ee6c-c777-7000-8000-000000012011" : "0199ee6c-c777-7000-8000-000000012012", last_seen_at: now, idle_expires_at: "2026-10-07T01:00:00.000Z", absolute_expires_at: "2026-10-08T00:00:00.000Z" } }; }
function organization() { return { archivedAt: null, createdAt: now, displayName: "Acme", id: organizationId, slug: "acme", status: "active", updatedAt: now, version: 1 }; }
function organizationMembers() { return [{ displayName: "Owner", role: "owner", userId: ownerId }, { displayName: "Member", role: "member", userId: memberId }]; }
function teamRecord(displayName: string, version: number): TeamRecord { return { createdAt: now, displayName, id: teamId, organizationId, slug: "platform", updatedAt: now, version }; }
function teamMemberRecord(): TeamMemberRecord { return { createdAt: now, organizationId, role: "member", teamId, updatedAt: now, userId: memberId, version: 1 }; }
function teamProjectRoleRecord(): TeamProjectRoleRecord { return { createdAt: now, organizationId, projectId, role: "write", teamId, updatedAt: now, version: 1 }; }
function project() { return { archivedAt: null, createdAt: now, id: projectId, name: "Atlas", ownerId: organizationId, ownerType: "organization", slug: "atlas", state: "active", storageScopeId: scopeId, updatedAt: now, version: 1 }; }
function sessionFrom(cookie: string | undefined): Session | undefined { if (cookie?.includes("nuriteo_dev_session=owner")) return "owner"; if (cookie?.includes("nuriteo_dev_session=member")) return "member"; return undefined; }
function header(request: http.IncomingMessage, name: string): string | undefined { const value = request.headers[name]; return Array.isArray(value) ? value[0] : value; }
function json(response: http.ServerResponse, value: unknown, status = 200) { response.statusCode = status; response.setHeader("content-type", "application/json"); response.end(JSON.stringify(value)); }
function problem(response: http.ServerResponse, status: number, code: string) { response.statusCode = status; response.setHeader("content-type", "application/problem+json"); response.end(JSON.stringify({ type: "about:blank", title: "Rejected", status, detail: "The request could not be completed.", instance: "/api/v1", code, request_id: "team-browser-request", errors: [] })); }
async function bodyOf(request: http.IncomingMessage): Promise<Record<string, unknown>> { const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)); return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>; }
async function listen(server: http.Server): Promise<void> { await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); }); }
async function reservePort(): Promise<number> { const server = http.createServer(); await listen(server); const address = server.address(); assert.ok(address && typeof address !== "string"); await new Promise<void>((resolve) => server.close(() => resolve())); return address.port; }
async function startWeb(corePort: number) { for (let attempt = 0; attempt < 5; attempt += 1) { const port = await reservePort(); const origin = `http://127.0.0.1:${port}`; const logFile = path.join(os.tmpdir(), `nuriteo-team-browser-${process.pid}-${attempt}.log`); const output = fs.openSync(logFile, "w+"); const child = spawn(process.execPath, [serverEntry], { cwd: standaloneWeb, env: { ...process.env, HOSTNAME: "127.0.0.1", NURITEO_INTERNAL_API_URL: `http://127.0.0.1:${corePort}`, PORT: String(port) }, stdio: ["ignore", output, output] }); try { await ready(origin, child); return { child, origin, output: () => fs.readFileSync(logFile, "utf8").slice(-4_000) }; } catch { await stopChild(child); fs.closeSync(output); } } throw new Error("standalone Web did not bind after bounded retries"); }
async function ready(origin: string, child: ReturnType<typeof spawn>) { const deadline = Date.now() + 15_000; while (Date.now() < deadline) { if (child.exitCode !== null) throw new Error("standalone exited"); try { const response = await fetch(`${origin}/sign-in`, { redirect: "manual" }); if (response.status < 500) return; } catch { /* starting */ } await new Promise((resolve) => setTimeout(resolve, 100)); } throw new Error("standalone readiness timed out"); }
async function stopChild(child: ReturnType<typeof spawn>) { if (child.exitCode !== null) return; child.kill("SIGTERM"); const exited = new Promise<boolean>((resolve) => child.once("exit", () => resolve(true))); if (await Promise.race([exited, new Promise<false>((resolve) => setTimeout(() => resolve(false), 2_000))])) return; child.kill("SIGKILL"); await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 1_000))]); }
async function contextFor(browser: import("@playwright/test").Browser, origin: string, session: Session, theme: "dark" | "light", viewport: { width: number; height: number }) { const context = await browser.newContext({ viewport }); await context.addCookies([{ name: "nuriteo_dev_session", value: session, url: origin }, { name: "nuriteo_dev_csrf", value: csrf, url: origin }, { name: "nuriteo-theme", value: theme, url: origin }]); return context; }
