import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { chromium, type BrowserContext, type Frame, type Page } from "@playwright/test";

const phase = requiredEnvironment("NURITEO_COMPOSE_BROWSER_PHASE");
const origin = new URL(requiredEnvironment("NURITEO_COMPOSE_EXTERNAL_URL")).origin;
const stateFile = requiredEnvironment("NURITEO_COMPOSE_BROWSER_STATE_FILE");
const adminPassword = readSecret("NURITEO_COMPOSE_ADMIN_PASSWORD_FILE");
const inviteePassword = readSecret("NURITEO_COMPOSE_INVITEE_PASSWORD_FILE");
const storageAccessKey = readSecret("NURITEO_COMPOSE_STORAGE_ACCESS_KEY_FILE");
const storageSecretKey = readSecret("NURITEO_COMPOSE_STORAGE_SECRET_KEY_FILE");
const privateStorageEndpoint = requiredEnvironment("NURITEO_COMPOSE_PRIVATE_STORAGE_ENDPOINT");
const inviteeEmail = "cmp003-invitee@example.invalid";
const inviteeDisplayName = "CMP 003 Invitee";
const editedSource = 'export const label = "saved through the bundled relay";\n';
let journeyStage = "launch";

assert.ok(phase === "save" || phase === "resume", "browser phase must be save or resume");

interface Ledger {
  readonly closingContexts: WeakSet<BrowserContext>;
  readonly errors: Error[];
  readonly requests: Array<{ headers: Record<string, string>; method: string; url: string }>;
  readonly responses: Array<{ headers: Record<string, string>; status: number; url: string }>;
  readonly pending: Promise<void>[];
  shuttingDown: boolean;
}

await main().catch((error: unknown) => {
  console.error(`compose bundled relay browser ${phase} phase failed (${journeyStage})`);
  console.error(`compose browser diagnostic: ${safeDiagnostic(error)}`);
  process.exitCode = 1;
});

function safeDiagnostic(error: unknown): string {
  const raw = error instanceof Error ? `${error.name}: ${error.message}` : "unknown browser failure";
  let safe = raw
    .replace(/https?:\/\/\S+/gu, "[url]")
    .replace(/nrt_(?:inv|org_inv)_[A-Za-z0-9._-]+/gu, "[token]");
  for (const secret of [adminPassword, inviteePassword, storageAccessKey, storageSecretKey]) {
    safe = safe.split(secret).join("[secret]");
  }
  return safe.slice(0, 1500).replace(/[\r\n]+/gu, " ");
}

async function main(): Promise<void> {
  const browser = await chromium.launch({
    args: [
      "--host-resolver-rules=MAP *.preview.localhost 127.0.0.1,MAP preview.localhost 127.0.0.1",
      "--no-proxy-server"
    ],
    headless: true
  });
  const ledger: Ledger = {
    closingContexts: new WeakSet(),
    errors: [],
    pending: [],
    requests: [],
    responses: [],
    shuttingDown: false
  };
  try {
    if (phase === "save") await saveJourney(browser, ledger);
    else await resumeJourney(browser, ledger);
    await drainLedger(ledger);
    assertNoPrivateStorageMaterial(JSON.stringify({ requests: ledger.requests, responses: ledger.responses }));
  } finally {
    ledger.shuttingDown = true;
    await browser.close();
    await drainLedger(ledger);
  }
  console.log(`compose bundled relay browser ${phase} phase passed`);
}

async function saveJourney(
  browser: Awaited<ReturnType<typeof chromium.launch>>,
  ledger: Ledger
): Promise<void> {
  const admin = await browser.newContext();
  const adminPage = await observedPage(admin, ledger);
  journeyStage = "admin-sign-in";
  await signIn(adminPage, "admin@example.invalid", adminPassword, true);

  journeyStage = "activation-invite";
  await adminPage.goto(`${origin}/admin/invitations`, { waitUntil: "networkidle" });
  await adminPage.getByLabel("Invitee email").fill(inviteeEmail);
  await adminPage.getByRole("button", { name: "Issue invitation" }).click();
  const activationUrl = await consumeInvitationUrl(
    adminPage,
    "activation email is queued",
    "smtp-activation-url",
    "/activate?token=nrt_inv_"
  );

  const invitee = await browser.newContext();
  const inviteePage = await observedPage(invitee, ledger);
  journeyStage = "activation-accept";
  await inviteePage.goto(activationUrl, { waitUntil: "networkidle" });
  await inviteePage.getByLabel("Email").fill(inviteeEmail);
  await inviteePage.getByLabel("Display name").fill(inviteeDisplayName);
  await inviteePage.getByLabel("Password").fill(inviteePassword);
  await inviteePage.getByRole("button", { name: "Activate account" }).click();
  await inviteePage.waitForURL("**/sign-in?activated=1");
  assert.equal(inviteePage.url().includes("token="), false);
  journeyStage = "invitee-sign-in";
  await signIn(inviteePage, inviteeEmail, inviteePassword, false);

  journeyStage = "organization-create";
  await adminPage.goto(`${origin}/organizations`, { waitUntil: "networkidle" });
  await adminPage.getByLabel("Slug").fill("cmp-003-organization");
  await adminPage.getByLabel("Display name").fill("CMP 003 Organization");
  await adminPage.getByRole("button", { name: "Create Organization" }).click();
  await adminPage.getByRole("heading", { name: "Invite member" }).waitFor();
  journeyStage = "organization-invite";
  await adminPage.getByLabel("Invitee email").fill(inviteeEmail);
  await adminPage.getByRole("button", { name: "Issue Organization invitation" }).click();
  const organizationInvitationUrl = await consumeInvitationUrl(
    adminPage,
    "invitation email is queued",
    "smtp-organization-url",
    "/organization-invitations/accept?token=nrt_org_inv_"
  );

  journeyStage = "organization-accept";
  await inviteePage.goto(organizationInvitationUrl, { waitUntil: "networkidle" });
  await inviteePage.getByRole("button", { name: "Accept invitation" }).click();
  await inviteePage.waitForURL("**/workspaces?joined=1");
  assert.equal(inviteePage.url().includes("token="), false);
  await inviteePage.getByRole("status").filter({ hasText: "Organization invitation accepted" }).waitFor();
  const workspaceLink = inviteePage
    .getByRole("navigation", { name: "Available Workspaces" })
    .getByRole("link", { name: /CMP 003 Organization Organization Workspace/u });
  await workspaceLink.waitFor();
  const workspaceHref = await workspaceLink.getAttribute("href");
  assert.ok(workspaceHref);
  const storageScope = new URL(workspaceHref, origin).searchParams.get("workspace");
  assert.match(storageScope ?? "", /^[0-9a-f-]{36}$/u);
  await Promise.all([
    inviteePage.waitForURL(`**/workspaces?workspace=${storageScope}`),
    workspaceLink.click()
  ]);

  journeyStage = "project-create";
  await adminPage.goto(`${origin}/projects?workspace=${storageScope}`, { waitUntil: "networkidle" });
  await adminPage.getByLabel("Slug").fill("cmp-003-relay");
  await adminPage.getByLabel("Name", { exact: true }).fill("CMP 003 Relay");
  await adminPage.getByRole("button", { name: "Create Project" }).click();
  await adminPage.getByRole("heading", { name: "CMP 003 Relay", exact: true }).waitFor();
  const projectUrl = adminPage.url();
  assert.equal(new URL(projectUrl).searchParams.get("workspace"), storageScope);
  assert.match(new URL(projectUrl).searchParams.get("project") ?? "", /^[0-9a-f-]{36}$/u);
  journeyStage = "project-grant";
  await adminPage.getByLabel("Organization member").selectOption({
    label: `${inviteeDisplayName} · Organization member`
  });
  await adminPage.getByLabel("Role").selectOption("write");
  await adminPage.getByRole("button", { name: "Grant role" }).click();
  await adminPage.locator("li", { hasText: inviteeDisplayName })
    .getByText(`${inviteeDisplayName} · Organization member`, { exact: true }).waitFor();

  journeyStage = "project-open";
  await inviteePage.goto(projectUrl, { waitUntil: "networkidle" });
  await inviteePage.getByRole("heading", { name: "CMP 003 Relay", exact: true }).waitFor();
  await runPreviewAndSave(inviteePage, ledger);
  assertNoPrivateStorageMaterial(await inviteePage.locator("body").innerText());
  fs.writeFileSync(stateFile, JSON.stringify({ editedSource, projectUrl }), { mode: 0o600 });

  await closeObservedContext(invitee, ledger);
  await closeObservedContext(admin, ledger);
}

async function consumeSmtpInvitationUrl(fileName: string, expectedPath: string): Promise<string> {
  const captureDirectory = requiredEnvironment("NURITEO_COMPOSE_SMTP_CAPTURE_DIR");
  const capturePath = path.join(captureDirectory, fileName);
  for (let attempt = 0; attempt < 240; attempt += 1) {
    if (fs.existsSync(capturePath)) {
      const value = fs.readFileSync(capturePath, "utf8").trim();
      fs.unlinkSync(capturePath);
      const parsed = new URL(value);
      assert.equal(parsed.origin, origin);
      assert.ok(value.includes(expectedPath));
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`SMTP invitation capture was not produced: ${fileName}`);
}

async function consumeInvitationUrl(
  page: Page,
  queuedText: string,
  captureFile: string,
  expectedPath: string
): Promise<string> {
  const result = page.locator('output, [role="status"]').first();
  await result.waitFor();
  if (await result.evaluate((element) => element.tagName === "OUTPUT")) {
    const value = (await result.textContent())?.trim() ?? "";
    const parsed = new URL(value);
    assert.equal(parsed.origin, origin);
    assert.ok(value.includes(expectedPath));
    return value;
  }
  assert.match((await result.textContent()) ?? "", new RegExp(queuedText, "iu"));
  return consumeSmtpInvitationUrl(captureFile, expectedPath);
}

async function runPreviewAndSave(page: Page, ledger: Ledger): Promise<void> {
  journeyStage = "runtime-start";
  await page.getByRole("button", { name: "Start workspace from template", exact: true }).click();
  await page.getByText("Starter template is ready in this browser.").waitFor({ timeout: 30_000 });
  journeyStage = "preview-start";
  await page.getByRole("button", { name: "Run Preview" }).click();
  const preview = page.getByRole("region", { name: "Preview" });
  await preview.locator("iframe").waitFor({ timeout: 30_000 });
  const previewUrl = await preview.getAttribute("data-preview-url");
  assert.ok(previewUrl);
  assert.match(
    previewUrl,
    /^http:\/\/r-[a-z2-7]{45}-p[1-9][0-9]*\.preview\.localhost:[0-9]+\/runtime-preview\/bootstrap$/u
  );
  const previewOrigin = new URL(previewUrl).origin;
  journeyStage = "preview-render";
  const previewFrame = await waitForPreviewFrame(page, previewOrigin);
  await previewFrame.getByRole("button", { name: "nuriteo:1" }).waitFor({ timeout: 30_000 });
  assert.equal(await previewFrame.evaluate(() => document.cookie), "");
  assert.equal(await previewFrame.evaluate(() => globalThis.crossOriginIsolated), true);

  journeyStage = "preview-file-open";
  await page.getByRole("button", { name: "src/message.ts" }).click();
  const editor = page.getByLabel("Editor for src/message.ts");
  journeyStage = "preview-edit";
  await editor.fill(editedSource);
  journeyStage = "preview-apply";
  await page.getByRole("button", { name: "Apply to Local Draft" }).click();
  journeyStage = "preview-hmr-status";
  await page.getByText("Local Draft saved · HMR applied", { exact: false }).waitFor({ timeout: 10_000 });
  journeyStage = "preview-hmr-dom";
  await previewFrame.getByRole("button", { name: "saved through the bundled relay:1" })
    .waitFor({ timeout: 20_000 });

  journeyStage = "relay-save-arm";
  const createResponsePromise = page.waitForResponse((response) =>
    response.request().method() === "POST" && response.url().endsWith("/save-sessions")
  );
  const uploadResponsePromise = page.waitForResponse((response) =>
    response.request().method() === "PUT"
      && response.url().includes("/save-sessions/")
      && response.url().endsWith("/upload")
  ).then(
    (response) => ({ response } as const),
    (error: unknown) => ({ error } as const)
  );
  journeyStage = "relay-save-submit";
  await page.getByRole("button", { name: "Save to server" }).click();
  journeyStage = "relay-save-create-response";
  const createResponse = await createResponsePromise;
  assert.equal(createResponse.status(), 201);
  journeyStage = "relay-save-transfer";
  const uploadOutcome = await uploadResponsePromise;
  if ("error" in uploadOutcome) {
    const statuses = await page.locator('[role="status"]').allTextContents();
    const alerts = await page.locator('[role="alert"]').allTextContents();
    throw new Error(`relay upload response missing; status=${statuses.join(" | ").slice(0, 240)}; alert=${alerts.join(" | ").slice(0, 240)}; createStatus=${createResponse.status()}`);
  }
  const uploadResponse = uploadOutcome.response;
  journeyStage = "relay-save-upload-response";
  assert.ok(uploadResponse.ok());
  const uploadRequest = uploadResponse.request();
  journeyStage = "relay-save-status";
  // Creating the Project yields v1, the write grant yields v2, and this Save
  // must commit the next canonical Project version.
  await page.getByText("Server Save v3 complete · Local Draft is current", { exact: true })
    .waitFor({ timeout: 30_000 });

  journeyStage = "relay-save-capability";
  const uploadUrl = new URL(uploadRequest.url());
  assert.equal(uploadRequest.method(), "PUT");
  assert.equal(uploadUrl.origin, origin);
  assert.match(
    uploadUrl.pathname,
    /^\/api\/v1\/workspaces\/organizations\/[0-9a-f-]{36}\/projects\/[0-9a-f-]{36}\/save-sessions\/[0-9a-f-]{36}\/upload$/u
  );
  assert.equal(ledger.requests.some((request) => request.url.includes("/parts/receipts")), false);
  assertNoPrivateStorageMaterial(uploadRequest.url());

  journeyStage = "relay-save-ledger";
  await drainLedger(ledger);
  const previewRequests = ledger.requests.filter((request) => request.url.startsWith(`${previewOrigin}/`));
  const previewResponses = ledger.responses.filter((response) => response.url.startsWith(`${previewOrigin}/`));
  assert.ok(previewRequests.length > 0, "isolated Preview request ledger must not be empty");
  assert.ok(previewResponses.some((response) => response.status === 200), "isolated Preview must return HTTP 200");
  for (const request of previewRequests) {
    assert.equal("cookie" in request.headers, false, "Preview request carried an application cookie");
    assert.equal("authorization" in request.headers, false, "Preview request carried Authorization");
    assert.equal("x-csrf-token" in request.headers, false, "Preview request carried CSRF credentials");
  }
  assertNoPrivateStorageMaterial(await previewFrame.locator("body").innerText());
}

async function resumeJourney(
  browser: Awaited<ReturnType<typeof chromium.launch>>,
  ledger: Ledger
): Promise<void> {
  journeyStage = "resume-state";
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8")) as {
    editedSource: string;
    projectUrl: string;
  };
  assert.equal(state.editedSource, editedSource);
  assert.equal(new URL(state.projectUrl).origin, origin);
  const context = await browser.newContext();
  const page = await observedPage(context, ledger);
  journeyStage = "resume-sign-in";
  await signIn(page, inviteeEmail, inviteePassword, true);
  journeyStage = "resume-project-navigation";
  await page.goto(state.projectUrl, { waitUntil: "networkidle" });
  journeyStage = "resume-project-fresh-draft";
  assert.equal(await page.locator("textarea").count(), 0, "fresh process must not inherit a Local Draft");
  journeyStage = "resume-project-submit";
  await page.getByRole("button", { name: "Resume saved Project" }).click();
  journeyStage = "resume-project-ready";
  const resumeOutcome = await page.waitForFunction(() => {
    const text = document.body.innerText;
    if (/Server Save v[1-9][0-9]* is ready in this browser\./u.test(text)) return "ready";
    if (text.includes("failed integrity verification")) return "integrity-failed";
    if (text.includes("no longer available to this account")) return "content-unavailable";
    if (text.includes("could not be resumed")) return "resume-failed";
    const runtimeFailure = text.match(/browser workspace could not be started safely\. \(RUNTIME_([A-Z0-9_]+)\)/u);
    if (runtimeFailure) return `runtime-${runtimeFailure[1].toLowerCase().replaceAll("_", "-")}`;
    if (text.includes("browser workspace could not be started safely")) return "runtime-failed";
    return null;
  }, undefined, { timeout: 30_000 }).then(
    (handle) => handle.jsonValue(),
    async (error: unknown) => {
      const statuses = await page.locator('[role="status"]').allTextContents();
      const alerts = await page.locator('[role="alert"]').allTextContents();
      const recentResponses = ledger.responses.slice(-12).map((response) => {
        const url = new URL(response.url);
        return `${response.status} ${url.pathname}`;
      });
      throw new Error(
        `resume readiness timed out; status=${statuses.join(" | ").slice(0, 320)}; `
        + `alert=${alerts.join(" | ").slice(0, 320)}; responses=${recentResponses.join(", ")}`,
        { cause: error }
      );
    }
  );
  journeyStage = `resume-project-${String(resumeOutcome)}`;
  assert.equal(resumeOutcome, "ready");
  journeyStage = "resume-project-source";
  const firstFile = page.getByRole("navigation", { name: "Project files" }).getByRole("button").first();
  await firstFile.waitFor();
  await firstFile.click();
  const editor = page.getByRole("textbox", { name: /^Editor for /u });
  await editor.waitFor();
  assert.ok((await editor.inputValue()).length > 0, "resumed current Server Save must contain readable source");
  assertNoPrivateStorageMaterial(await page.locator("body").innerText());
  await closeObservedContext(context, ledger);
}

async function signIn(
  page: Page,
  email: string,
  password: string,
  navigate: boolean
): Promise<void> {
  if (navigate) await page.goto(`${origin}/sign-in`, { waitUntil: "domcontentloaded" });
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((url) => url.pathname === "/workspaces", { timeout: 15_000 });
}

async function observedPage(context: BrowserContext, ledger: Ledger): Promise<Page> {
  const page = await context.newPage();
  page.on("request", (request) => {
    const pending = request.allHeaders()
      .then((headers) => {
        ledger.requests.push({ headers, method: request.method(), url: request.url() });
      })
      .catch((error: unknown) => recordLedgerError(error, context, ledger));
    ledger.pending.push(pending);
  });
  page.on("response", (response) => {
    // Response metadata is already available when this event fires. Using
    // allHeaders() here can remain pending for long-lived Preview responses and
    // prevent the gate from draining its ledger after a successful save.
    ledger.responses.push({
      headers: response.headers(),
      status: response.status(),
      url: response.url()
    });
  });
  return page;
}

async function closeObservedContext(context: BrowserContext, ledger: Ledger): Promise<void> {
  ledger.closingContexts.add(context);
  await context.close();
}

async function drainLedger(ledger: Ledger): Promise<void> {
  let consumed = 0;
  while (consumed < ledger.pending.length) {
    const end = ledger.pending.length;
    await Promise.all(ledger.pending.slice(consumed, end));
    consumed = end;
    await Promise.resolve();
  }
  assert.equal(ledger.errors.length, 0, "browser header ledger collection failed");
}

function recordLedgerError(error: unknown, context: BrowserContext, ledger: Ledger): void {
  if ((ledger.shuttingDown || ledger.closingContexts.has(context)) && isTargetClosed(error)) return;
  ledger.errors.push(error instanceof Error ? error : new Error("unknown header ledger failure"));
}

function isTargetClosed(error: unknown): boolean {
  return error instanceof Error && /Target page, context or browser has been closed/u.test(error.message);
}

async function waitForPreviewFrame(page: Page, expectedOrigin: string): Promise<Frame> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const frame = page.frames().find((candidate) => {
      try {
        const url = new URL(candidate.url());
        return url.origin === expectedOrigin && url.pathname === "/";
      } catch {
        return false;
      }
    });
    if (frame) return frame;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("isolated Preview frame was not attached");
}

function assertNoPrivateStorageMaterial(value: string): void {
  for (const forbidden of [
    privateStorageEndpoint,
    new URL(privateStorageEndpoint).host,
    storageAccessKey,
    storageSecretKey,
    "X-Amz-",
    "x-amz-signature",
    "staging/"
  ]) {
    assert.equal(value.includes(forbidden), false, "browser-visible data exposed private storage material");
  }
}

function readSecret(environmentName: string): string {
  return fs.readFileSync(requiredEnvironment(environmentName), "utf8").trim();
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
