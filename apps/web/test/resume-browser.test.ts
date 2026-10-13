import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "@playwright/test";

import { validateProjectBundleV1Projection } from "../src/bundles/project-bundle-v1-validation.ts";
import { writeValidatedProjectBundleV1 } from "../src/bundles/project-bundle-v1.ts";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const standaloneWeb = path.join(webRoot, ".next/standalone/apps/web");
const serverEntry = path.join(standaloneWeb, "server.js");
const userId = "0199ee6c-c777-7000-8000-00000000e001";
const scopeId = "0199ee6c-c777-7000-8000-00000000e002";
const projectId = "0199ee6c-c777-7000-8000-00000000e003";
const bundleId = "0199ee6c-c777-7000-8000-00000000e004";
const sessionId = "0199ee6c-c777-7000-8000-00000000e005";
const now = "2026-10-04T00:00:00.000Z";
const archive = await writeValidatedProjectBundleV1(validateProjectBundleV1Projection({
  projectId,
  storageScopeId: scopeId,
  files: [
    { path: "package.json", kind: "text", executable: false, bytes: encode("{\"scripts\":{\"dev\":\"vite\"},\"dependencies\":{\"vite\":\"6.1.0\"}}\n") },
    { path: "public/logo.bin", kind: "binary", executable: false, bytes: Uint8Array.of(0, 255, 1, 128) },
    { path: "src/main.tsx", kind: "text", executable: false, bytes: encode("document.querySelector('#app')!.textContent = 'resumed in a new context';\n") }
  ]
}));
const checksum = createHash("sha256").update(archive.bytes).digest("base64url");
const etag = `"content-v7-${checksum}"`;
const projectPath = `/api/v1/workspaces/users/${userId}/projects/${projectId}`;
const downloadPath = `${projectPath}/content/${bundleId}`;
const requests: string[] = [];

assert.ok(fs.existsSync(serverEntry), "Run the production build before this browser check.");
fs.cpSync(path.join(webRoot, ".next/static"), path.join(standaloneWeb, ".next/static"), { force: true, recursive: true });
fs.cpSync(path.join(webRoot, "public/runtime"), path.join(standaloneWeb, "public/runtime"), { force: true, recursive: true });

const core = http.createServer((request, response) => {
  const requestPath = request.url ?? "/";
  requests.push(`${request.method} ${requestPath}`);
  response.setHeader("cache-control", "private, no-store");
  response.setHeader("x-request-id", "web-008-browser");
  if (!request.headers.cookie?.includes("nuriteo_dev_session=saved")) return problem(response, 401);
  if (request.method === "GET" && requestPath === "/api/v1/me") return json(response, {
    user: { id: userId, email: "saved@example.test", display_name: "Saved User", is_instance_admin: false },
    session: { id: sessionId, last_seen_at: now, idle_expires_at: "2026-10-04T01:00:00.000Z", absolute_expires_at: "2026-10-05T00:00:00.000Z" }
  });
  if (request.method === "GET" && requestPath === "/api/v1/me/workspaces") return json(response, {
    workspaces: [{ ownerType: "user", ownerId: userId, displayLabel: "Saved Personal", storageScopeId: scopeId }]
  });
  const collection = `/api/v1/workspaces/users/${userId}/projects`;
  if (request.method === "GET" && requestPath.startsWith(`${collection}?`)) {
    return json(response, { items: [project()], nextCursor: null });
  }
  if (request.method === "GET" && requestPath === projectPath) {
    response.setHeader("etag", '"project-v1"');
    return json(response, project());
  }
  if (request.method === "GET" && requestPath === `${projectPath}/content`) {
    response.setHeader("etag", etag);
    return json(response, {
      projectId, projectVersion: 7, bundleId, etag, checksumAlgorithm: "sha-256", checksum,
      physicalBytes: archive.bytes.byteLength, logicalBytes: archive.manifest.logicalBytes,
      fileCount: archive.manifest.fileCount, format: "project-bundle-v1", downloadUrl: downloadPath
    });
  }
  if (request.method === "GET" && requestPath === downloadPath) {
    assert.equal(request.headers["if-match"], etag);
    response.statusCode = 200;
    response.setHeader("cache-control", "private, no-store");
    response.setHeader("content-disposition", "attachment; filename=\"nuriteo-project-bundle.tar\"");
    response.setHeader("content-length", String(archive.bytes.byteLength));
    response.setHeader("content-type", "application/octet-stream");
    response.setHeader("etag", etag);
    response.setHeader("x-content-type-options", "nosniff");
    response.write(Buffer.from(archive.bytes.subarray(0, 700)));
    response.end(Buffer.from(archive.bytes.subarray(700)));
    return;
  }
  return problem(response, 404);
});

await listen(core);
const coreAddress = core.address();
assert.ok(coreAddress && typeof coreAddress !== "string");
const standalone = await startWeb(coreAddress.port);
try {
  const browser = await chromium.launch({ headless: true });
  try {
    const projectUrl = `${standalone.origin}/projects?workspace=${scopeId}&state=active&project=${projectId}`;
    const firstContext = await signedContext(browser, standalone.origin);
    const firstPage = await firstContext.newPage();
    await firstPage.goto(projectUrl, { waitUntil: "networkidle" });
    await firstPage.getByRole("button", { name: "Resume saved Project" }).waitFor();
    await firstContext.close();

    const newContext = await signedContext(browser, standalone.origin);
    const page = await newContext.newPage();
    await page.goto(projectUrl, { waitUntil: "networkidle" });
    assert.equal(await page.locator("textarea").count(), 0, "a fresh context must not inherit a Local Draft");
    await page.getByRole("button", { name: "Resume saved Project" }).click();
    try {
      await page.getByText("Server Save v7 is ready in this browser.").waitFor({ timeout: 30_000 });
    } catch (error) {
      const visibleText = (await page.locator("body").innerText()).slice(0, 4_096);
      throw new Error(`Resume did not complete.\nRequests:\n${requests.join("\n")}\nPage:\n${visibleText}`, { cause: error });
    }
    await page.getByRole("button", { name: "src/main.tsx" }).click();
    await page.getByLabel("Editor for src/main.tsx").waitFor();
    assert.match(await page.getByLabel("Editor for src/main.tsx").inputValue(), /resumed in a new context/u);
    await page.getByRole("button", { name: "public/logo.bin" }).click();
    await page.getByText("Binary and unsupported files cannot be opened in the text editor.").waitFor();
    assert.equal(await page.getByText(/failed integrity verification/u).count(), 0);
    await newContext.close();
  } finally {
    await browser.close();
  }
  assert.ok(requests.includes(`GET ${projectPath}/content`));
  assert.ok(requests.includes(`GET ${downloadPath}`));
} finally {
  await stopChild(standalone.child);
  await new Promise<void>((resolve) => core.close(() => resolve()));
}

console.log("WEB-008 new browser context resume passed");

function project() {
  return { id: projectId, ownerType: "user", ownerId: userId, storageScopeId: scopeId, slug: "saved-project", name: "Saved Project", state: "active", createdAt: now, updatedAt: now, archivedAt: null, version: 1 };
}
function encode(value: string): Uint8Array { return new TextEncoder().encode(value); }
function json(response: http.ServerResponse, value: unknown) { response.statusCode = 200; response.setHeader("content-type", "application/json"); response.end(JSON.stringify(value)); }
function problem(response: http.ServerResponse, status: number) { response.statusCode = status; response.setHeader("content-type", "application/problem+json"); response.end(JSON.stringify({ type: "about:blank", title: "Rejected", status, detail: "Rejected.", instance: "/api/v1", code: "REJECTED", request_id: "web-008-browser", errors: [] })); }
async function listen(server: http.Server): Promise<void> { await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); }); }
async function reservePort(): Promise<number> { const server = http.createServer(); await listen(server); const address = server.address(); assert.ok(address && typeof address !== "string"); await new Promise<void>((resolve) => server.close(() => resolve())); return address.port; }
async function startWeb(corePort: number) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const port = await reservePort();
    const origin = `http://127.0.0.1:${port}`;
    const child = spawn(process.execPath, [serverEntry], { cwd: standaloneWeb, env: { ...process.env, HOSTNAME: "127.0.0.1", NURITEO_INTERNAL_API_URL: `http://127.0.0.1:${corePort}`, PORT: String(port) }, stdio: "ignore" });
    try { await ready(origin, child); return { child, origin }; } catch { await stopChild(child); }
  }
  throw new Error("standalone Web did not bind after bounded retries");
}
async function ready(origin: string, child: ReturnType<typeof spawn>) { const deadline = Date.now() + 15_000; while (Date.now() < deadline) { if (child.exitCode !== null) throw new Error("standalone exited"); try { const response = await fetch(`${origin}/sign-in`, { redirect: "manual" }); if (response.status < 500) return; } catch { /* starting */ } await new Promise((resolve) => setTimeout(resolve, 100)); } throw new Error("standalone readiness timed out"); }
async function stopChild(child: ReturnType<typeof spawn>) { if (child.exitCode !== null) return; child.kill("SIGTERM"); const exited = new Promise<boolean>((resolve) => child.once("exit", () => resolve(true))); if (await Promise.race([exited, new Promise<false>((resolve) => setTimeout(() => resolve(false), 2_000))])) return; child.kill("SIGKILL"); await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 1_000))]); }
async function signedContext(browser: import("@playwright/test").Browser, origin: string) { const context = await browser.newContext(); await context.addCookies([{ name: "nuriteo_dev_session", value: "saved", url: origin }]); return context; }
