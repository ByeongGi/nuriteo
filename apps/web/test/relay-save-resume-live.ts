import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "@playwright/test";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const standaloneWeb = path.join(webRoot, ".next/standalone/apps/web");
const serverEntry = path.join(standaloneWeb, "server.js");
const coreUrl = requiredEnvironment("NURITEO_CLIENT_TEST_BASE_URL");
const publicWebUrl = requiredEnvironment("NURITEO_CLIENT_TEST_EXTERNAL_URL");
const rustfsUrl = requiredEnvironment("NURITEO_S3_ENDPOINT");
const password = fs.readFileSync(requiredEnvironment("NURITEO_CLIENT_TEST_PASSWORD_FILE"), "utf8").trim();
const accessKey = fs.readFileSync(requiredEnvironment("NURITEO_S3_ACCESS_KEY_ID_FILE"), "utf8").trim();
const secretKey = fs.readFileSync(requiredEnvironment("NURITEO_S3_SECRET_ACCESS_KEY_FILE"), "utf8").trim();
const editedSource = 'export const message = "saved through the private relay";\n';

assert.equal(requiredEnvironment("NURITEO_CLIENT_TEST_SAVE_UPLOAD_TRANSPORT"), "relay");
assert.ok(fs.existsSync(serverEntry), "Run the production Web build before the actual relay fixture.");
fs.cpSync(path.join(webRoot, ".next/static"), path.join(standaloneWeb, ".next/static"), { force: true, recursive: true });
fs.cpSync(path.join(webRoot, "public"), path.join(standaloneWeb, "public"), { force: true, recursive: true });

const standalone = await startWeb(publicWebUrl, coreUrl);
const browser = await chromium.launch({ headless: true });
const browserRequests: string[] = [];
try {
  const firstContext = await browser.newContext();
  const firstPage = await firstContext.newPage();
  firstPage.on("request", (request) => browserRequests.push(`${request.method()} ${request.url()}`));
  await signIn(firstPage, standalone.origin, password);
  await firstPage.goto(`${standalone.origin}/projects`, { waitUntil: "networkidle" });
  await firstPage.getByLabel("Slug").fill("web-011-relay");
  await firstPage.getByLabel("Name", { exact: true }).fill("WEB 011 Relay");
  await firstPage.getByRole("button", { name: "Create Project" }).click();
  await firstPage.getByRole("heading", { name: "WEB 011 Relay", exact: true }).waitFor();
  const projectUrl = firstPage.url();
  const projectId = new URL(projectUrl).searchParams.get("project");
  assert.ok(projectId, "created Project URL must contain its identity");

  await firstPage.getByRole("button", { name: "Start workspace from template", exact: true }).click();
  await firstPage.getByText("Starter template is ready in this browser.").waitFor({ timeout: 30_000 });
  await firstPage.getByRole("button", { name: "src/message.ts" }).click();
  const editor = firstPage.getByLabel("Editor for src/message.ts");
  await editor.fill(editedSource);
  await firstPage.getByRole("button", { name: "Apply to Local Draft" }).click();

  const createResponsePromise = firstPage.waitForResponse((response) =>
    response.request().method() === "POST" && response.url().endsWith("/save-sessions")
  );
  const uploadRequestPromise = firstPage.waitForRequest((request) =>
    request.method() === "PUT" && request.url().includes("/save-sessions/") && request.url().endsWith("/upload")
  );
  await firstPage.getByRole("button", { name: "Save to server" }).click();
  const [createResponse, uploadRequest] = await Promise.all([createResponsePromise, uploadRequestPromise]);
  await firstPage.getByText("Server Save v2 complete · Local Draft is current", { exact: true }).waitFor({ timeout: 30_000 });

  const capabilityText = await createResponse.text();
  const created = JSON.parse(capabilityText) as {
    sessionId: string;
    upload: Record<string, unknown>;
  };
  assert.equal(created.upload.transport, "relay");
  assert.equal(created.upload.method, "PUT");
  assert.equal(created.upload.path, new URL(uploadRequest.url()).pathname);
  assert.equal(Object.hasOwn(created.upload, "url"), false);
  assert.equal(uploadRequest.url(), `${standalone.origin}${String(created.upload.path)}`);
  assert.equal((await uploadRequest.allHeaders())["x-csrf-token"]?.startsWith("nrt_csrf_"), true);
  assertNoPrivateStorageMaterial(capabilityText, rustfsUrl, accessKey, secretKey);
  assert.equal(browserRequests.some((entry) => entry.includes("/parts/receipts")), false);
  assert.equal(browserRequests.some((entry) => entry.includes(new URL(rustfsUrl).host)), false);

  await firstContext.close();
  const freshContext = await browser.newContext();
  const freshPage = await freshContext.newPage();
  freshPage.on("request", (request) => browserRequests.push(`${request.method()} ${request.url()}`));
  await signIn(freshPage, standalone.origin, password);
  await freshPage.goto(projectUrl, { waitUntil: "networkidle" });
  assert.equal(await freshPage.locator("textarea").count(), 0, "fresh BrowserContext must not inherit the Local Draft");
  await freshPage.getByRole("button", { name: "Resume saved Project" }).click();
  await freshPage.getByText("Server Save v2 is ready in this browser.").waitFor({ timeout: 30_000 });
  await freshPage.getByRole("button", { name: "src/message.ts" }).click();
  assert.equal(await freshPage.getByLabel("Editor for src/message.ts").inputValue(), editedSource);
  assert.equal(browserRequests.some((entry) => entry.includes(new URL(rustfsUrl).host)), false);
  await freshContext.close();
} finally {
  await browser.close();
  await stopChild(standalone.child);
}

console.log("WEB-011 actual private RustFS relay Save and fresh BrowserContext Resume passed");

async function signIn(
  page: import("@playwright/test").Page,
  origin: string,
  adminPassword: string
): Promise<void> {
  await page.goto(`${origin}/sign-in`, { waitUntil: "domcontentloaded" });
  await page.getByLabel("Email").fill("admin@example.test");
  await page.getByLabel("Password").fill(adminPassword);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((url) => url.pathname === "/workspaces", { timeout: 15_000 });
}

function assertNoPrivateStorageMaterial(
  value: string,
  privateEndpoint: string,
  storageAccessKey: string,
  storageSecretKey: string
): void {
  for (const forbidden of [privateEndpoint, new URL(privateEndpoint).host, storageAccessKey, storageSecretKey, "X-Amz-", "staging/"]) {
    assert.equal(value.includes(forbidden), false, "relay capability exposed private storage material");
  }
}

async function startWeb(
  publicUrl: string,
  internalApiUrl: string
): Promise<{ child: ReturnType<typeof spawn>; origin: string }> {
  const origin = new URL(publicUrl);
  assert.equal(origin.protocol, "http:");
  assert.equal(origin.hostname, "127.0.0.1");
  assert.ok(origin.port, "actual Web public origin must have a reserved port");
  assert.equal(origin.pathname, "/");
  assert.equal(origin.search, "");
  assert.equal(origin.hash, "");

  const child = spawn(process.execPath, [serverEntry], {
    cwd: standaloneWeb,
    env: {
      ...process.env,
      HOSTNAME: origin.hostname,
      NURITEO_INTERNAL_API_URL: internalApiUrl,
      PORT: origin.port
    },
    stdio: "ignore"
  });
  try {
    await ready(origin.origin, child);
    return { child, origin: origin.origin };
  } catch (cause) {
    await stopChild(child);
    throw cause;
  }
}

async function ready(origin: string, child: ReturnType<typeof spawn>): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error("standalone Web exited before readiness");
    try {
      const response = await fetch(`${origin}/sign-in`, { redirect: "manual" });
      if (response.status < 500) return;
    } catch { /* standalone is starting */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("standalone Web readiness timed out");
}

async function stopChild(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  const exited = new Promise<boolean>((resolve) => child.once("exit", () => resolve(true)));
  if (await Promise.race([exited, new Promise<false>((resolve) => setTimeout(() => resolve(false), 2_000))])) return;
  child.kill("SIGKILL");
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 1_000))]);
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
