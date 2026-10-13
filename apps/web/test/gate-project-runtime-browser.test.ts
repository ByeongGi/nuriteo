import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "@playwright/test";

declare global {
  interface Window {
    __nuriteoGateWorkerProbe: { active: number; created: number };
  }
}

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const standaloneDirectory = path.join(webRoot, ".next/standalone/apps/web");
const serverEntry = path.join(standaloneDirectory, "server.js");
const coreUrl = requiredEnvironment("NURITEO_TEST_CORE_URL");
const webPort = Number(requiredEnvironment("NURITEO_TEST_WEB_PORT"));
const adminEmail = requiredEnvironment("NURITEO_TEST_ADMIN_EMAIL");
const adminPassword = requiredEnvironment("NURITEO_TEST_ADMIN_PASSWORD");
const applicationOrigin = `http://localhost:${webPort}`;
const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "nuriteo-gate-003-browser-"));
const signingKeyFile = path.join(temporaryDirectory, "preview-signing-key");
fs.writeFileSync(signingKeyFile, randomBytes(32).toString("base64url"), { mode: 0o600 });

assert.ok(Number.isInteger(webPort) && webPort >= 1 && webPort <= 65_535, "GATE-003 Web port is invalid");
assert.ok(fs.existsSync(serverEntry), "run the production Web build before GATE-003");
fs.cpSync(path.join(webRoot, ".next/static"), path.join(standaloneDirectory, ".next/static"), { force: true, recursive: true });
fs.cpSync(path.join(webRoot, "public"), path.join(standaloneDirectory, "public"), { force: true, recursive: true });

const web = spawn(process.execPath, [serverEntry], {
  cwd: standaloneDirectory,
  env: {
    ...process.env,
    HOSTNAME: "127.0.0.1",
    NURITEO_EXTERNAL_URL: applicationOrigin,
    NURITEO_INTERNAL_API_URL: coreUrl,
    NURITEO_PREVIEW_BASE_DOMAIN: "preview.localhost",
    NURITEO_PREVIEW_SIGNING_KEY_FILE: signingKeyFile,
    PORT: String(webPort)
  },
  stdio: ["ignore", "pipe", "pipe"]
});
const webOutput = captureOutput(web);

try {
  await waitForWeb(web);
  const browser = await chromium.launch({
    args: [
      "--host-resolver-rules=MAP *.preview.localhost 127.0.0.1,MAP preview.localhost 127.0.0.1,EXCLUDE localhost",
      "--no-proxy-server"
    ],
    headless: true
  });
  try {
    const context = await browser.newContext({ viewport: { height: 1200, width: 1920 } });
    await context.addInitScript(() => {
      const NativeWorker = globalThis.Worker;
      class TrackingWorker extends NativeWorker {
        #active = true;
        constructor(scriptURL: string | URL, options?: WorkerOptions) {
          super(scriptURL, options);
          window.__nuriteoGateWorkerProbe.active += 1;
          window.__nuriteoGateWorkerProbe.created += 1;
        }
        override terminate(): void {
          if (this.#active) {
            this.#active = false;
            window.__nuriteoGateWorkerProbe.active -= 1;
          }
          super.terminate();
        }
      }
      window.__nuriteoGateWorkerProbe = { active: 0, created: 0 };
      Object.defineProperty(globalThis, "Worker", { configurable: true, value: TrackingWorker });
    });
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    const workerVersions = new Map<string, { scriptURL: string; status: string }>();
    cdp.on("ServiceWorker.workerVersionUpdated", (event: { versions: Array<{ scriptURL: string; status: string; versionId: string }> }) => {
      for (const version of event.versions) workerVersions.set(version.versionId, version);
    });
    await cdp.send("ServiceWorker.enable");
    const pageErrors: string[] = [];
    const requestFailures: string[] = [];
    const previewResponses: string[] = [];
    const previewHeaders: Array<Promise<Record<string, string>>> = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("requestfailed", (request) => requestFailures.push(`${request.url()} ${request.failure()?.errorText ?? "unknown"}`));
    page.on("response", (response) => {
      if (response.url().includes(".preview.localhost:")) previewResponses.push(`${response.status()} ${response.url()}`);
    });
    page.on("request", (request) => {
      if (request.url().includes(".preview.localhost:")) previewHeaders.push(request.allHeaders());
    });

    await page.goto(`${applicationOrigin}/sign-in`, { waitUntil: "networkidle" });
    await page.getByLabel("Email").fill(adminEmail);
    await page.getByLabel("Password").fill(adminPassword);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL(`${applicationOrigin}/workspaces`);
    await page.getByRole("heading", { name: "Workspaces", exact: true }).waitFor();

    await page.goto(`${applicationOrigin}/projects`, { waitUntil: "networkidle" });
    await page.getByRole("heading", { name: "Projects" }).waitFor();
    await page.getByLabel("Slug").fill("gate-runtime");
    await page.getByLabel("Name", { exact: true }).fill("GATE Runtime Project");
    const creation = page.waitForResponse((response) => response.request().method() === "POST" && /\/projects$/u.test(response.url()));
    await page.getByRole("button", { name: "Create Project" }).click();
    assert.equal((await creation).status(), 201);
    await page.getByRole("heading", { name: "GATE Runtime Project", exact: true }).waitFor();
    assert.match(page.url(), /[?&]project=[0-9a-f-]+/u);

    await page.getByRole("button", { name: "Start workspace" }).click();
    await page.getByRole("button", { name: "Run Preview" }).waitFor({ timeout: 30_000 });
    await page.getByRole("button", { name: "src/message.ts" }).click();
    assert.equal(await page.getByLabel("Editor for src/message.ts").isEditable(), true);
    const workerAfterMount = await page.evaluate(() => ({ ...window.__nuriteoGateWorkerProbe }));
    assert.equal(workerAfterMount.created, 2, "production Runtime must start its system and process Workers");
    assert.equal(workerAfterMount.active, 2);

    await page.getByRole("button", { name: "Run Preview" }).click();
    const previewRegion = page.getByRole("region", { name: "Preview" });
    await previewRegion.locator("iframe").waitFor({ timeout: 30_000 });
    const firstPreviewUrl = await previewRegion.getAttribute("data-preview-url");
    assert(firstPreviewUrl);
    assert.match(firstPreviewUrl, new RegExp(`^http://r-[a-z2-7]{45}-p[1-9][0-9]*\\.preview\\.localhost:${webPort}/runtime-preview/bootstrap$`, "u"));
    const firstPreviewOrigin = new URL(firstPreviewUrl).origin;
    const firstFrame = await waitForFrame(page, firstPreviewOrigin, { previewResponses, requestFailures });
    await firstFrame.getByRole("button", { name: "nuriteo:1" }).waitFor({ timeout: 30_000 });
    assert.equal(await firstFrame.evaluate(() => document.cookie), "", "Preview origin must not receive application cookies");
    assert.equal(await firstFrame.evaluate(() => globalThis.crossOriginIsolated), true);
    assert.equal(await firstFrame.evaluate(() => navigator.serviceWorker.controller?.scriptURL.endsWith("/runtime-preview/sw.js")), true);

    const editor = page.getByLabel("Editor for src/message.ts");
    await editor.fill('export const label = "GATE003 edited";\n');
    await page.getByRole("button", { name: "Apply to Local Draft" }).click();
    await page.getByText("Local Draft saved · HMR applied", { exact: false }).waitFor({ timeout: 10_000 });
    await firstFrame.getByRole("button", { name: "GATE003 edited:1" }).waitFor({ timeout: 20_000 });

    const firstWorkerVersion = await waitForWorkerVersion(workerVersions, firstPreviewOrigin);
    await cdp.send("ServiceWorker.unregister", { scopeURL: `${firstPreviewOrigin}/` });
    await cdp.send("ServiceWorker.stopWorker", { versionId: firstWorkerVersion });
    await new Promise((resolve) => setTimeout(resolve, 6_000));
    const staleAfterFailure = await context.newPage();
    const staleAfterFailureResponse = await staleAfterFailure.goto(firstPreviewUrl, { waitUntil: "domcontentloaded" });
    assert.equal(staleAfterFailureResponse?.status(), 410, "failed Preview relay must not expose its stale signed host");
    await staleAfterFailure.close();

    await page.getByRole("button", { name: "Stop workspace" }).click();
    await page.getByRole("button", { name: "Start workspace" }).waitFor({ timeout: 10_000 });
    await page.waitForFunction(() => window.__nuriteoGateWorkerProbe.active === 0);
    await page.getByRole("button", { name: "Start workspace" }).click();
    await page.getByRole("button", { name: "Run Preview" }).waitFor({ timeout: 30_000 });
    await page.getByRole("button", { name: "src/message.ts" }).click();
    await page.getByRole("button", { name: "Run Preview" }).click();
    await previewRegion.locator("iframe").waitFor({ timeout: 30_000 });
    const recoveredPreviewUrl = await previewRegion.getAttribute("data-preview-url");
    assert(recoveredPreviewUrl && recoveredPreviewUrl !== firstPreviewUrl, "user recovery must issue a fresh signed host");
    const recoveredPreviewOrigin = new URL(recoveredPreviewUrl).origin;
    const recoveredFrame = await waitForFrame(page, recoveredPreviewOrigin, { previewResponses, requestFailures });
    await recoveredFrame.getByRole("button", { name: /:1$/u }).waitFor({ timeout: 20_000 });
    const recoveredEditor = page.getByLabel("Editor for src/message.ts");
    await recoveredEditor.fill('export const label = "GATE003 recovered";\n');
    await page.getByRole("button", { name: "Apply to Local Draft" }).click();
    await recoveredFrame.getByRole("button", { name: "GATE003 recovered:1" }).waitFor({ timeout: 20_000 });

    await page.getByRole("button", { name: "Stop workspace" }).click();
    await page.getByRole("button", { name: "Start workspace" }).waitFor({ timeout: 10_000 });
    await page.waitForFunction(() => window.__nuriteoGateWorkerProbe.active === 0);
    assert.equal(await previewRegion.locator("iframe").count(), 0);
    await waitForStatus(context, recoveredPreviewUrl, 410);
    const stalePage = await context.newPage();
    const staleResponse = await stalePage.goto(recoveredPreviewUrl, { waitUntil: "domcontentloaded" });
    assert.equal(staleResponse?.status(), 410, "stopped signed Preview must fail closed");
    assert.equal(await stalePage.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length), 0);
    await stalePage.close();

    const observedPreviewHeaders = await Promise.all(previewHeaders);
    assert(observedPreviewHeaders.length > 0, "GATE-003 did not observe Preview-origin traffic");
    for (const headers of observedPreviewHeaders) {
      assert.equal(headers.cookie, undefined, "application cookie leaked to Preview origin");
      assert.equal(headers.authorization, undefined, "authorization leaked to Preview origin");
      assert.equal(headers["x-csrf-token"], undefined, "CSRF credential leaked to Preview origin");
    }
    assert.deepEqual(pageErrors, []);
    console.log("GATE-003 actual aggregate browser journey ok");
  } finally {
    await browser.close();
  }
} finally {
  await stop(web);
  const output = await webOutput;
  assert.doesNotMatch(output, new RegExp(escapeRegularExpression(adminPassword), "u"));
  fs.rmSync(temporaryDirectory, { force: true, recursive: true });
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function waitForWeb(child: ReturnType<typeof spawn>): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`production Web exited with ${child.exitCode}`);
    try {
      const response = await fetch(`${applicationOrigin}/sign-in`);
      if (response.status < 500) return;
    } catch { /* starting */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("production Web readiness timed out");
}

async function waitForFrame(
  page: import("@playwright/test").Page,
  origin: string,
  diagnostics: { previewResponses: readonly string[]; requestFailures: readonly string[] }
): Promise<import("@playwright/test").Frame> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const frame = page.frames().find((candidate) => {
      try { return new URL(candidate.url()).origin === origin && new URL(candidate.url()).pathname === "/"; } catch { return false; }
    });
    if (frame) return frame;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const frames = await Promise.all(page.frames().map(async (frame) => ({
    body: await frame.locator("body").textContent().catch(() => null),
    url: frame.url()
  })));
  throw new Error(`Preview frame at ${origin} was not attached: ${JSON.stringify({ ...diagnostics, frames })}`);
}

async function waitForWorkerVersion(
  versions: ReadonlyMap<string, { scriptURL: string; status: string }>,
  origin: string
): Promise<string> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    for (const [versionId, version] of versions) {
      if (version.scriptURL === `${origin}/runtime-preview/sw.js` && version.status === "activated") return versionId;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Preview Service Worker version was not observed");
}

async function waitForStatus(context: import("@playwright/test").BrowserContext, url: string, expected: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const response = await context.request.get(url, { failOnStatusCode: false });
    if (response.status() === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Preview host did not reach HTTP ${expected}`);
}

function captureOutput(child: ReturnType<typeof spawn>): Promise<string> {
  const chunks: Buffer[] = [];
  child.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk));
  child.stderr?.on("data", (chunk: Buffer) => chunks.push(chunk));
  return new Promise((resolve) => child.once("close", () => resolve(Buffer.concat(chunks).toString("utf8").slice(-1024 * 1024))));
}

async function stop(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  const exited = new Promise<boolean>((resolve) => child.once("exit", () => resolve(true)));
  if (await Promise.race([exited, new Promise<false>((resolve) => setTimeout(() => resolve(false), 3_000))])) return;
  child.kill("SIGKILL");
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 1_000))]);
}

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
