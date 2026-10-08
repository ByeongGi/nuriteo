import assert from "node:assert/strict";
import fs from "node:fs";

import { chromium, type BrowserContext, type Frame, type Request, type Response } from "@playwright/test";

const origin = new URL(required("NURITEO_BETA_GATE_ORIGIN")).origin;
const identity = JSON.parse(
  fs.readFileSync(required("NURITEO_BETA_GATE_PUBLISHED_IDENTITY_FILE"), "utf8")
) as {
  projectId: string;
  projectVersionId: string;
  publicId: string;
  versionNumber: number;
};
const output = required("NURITEO_BETA_GATE_STAGE_OUTPUT");
const fixedPath = `/examples/${identity.publicId}/versions/${identity.versionNumber}`;
const metadataPath = `/api/v1/published-examples/${identity.publicId}/versions/${identity.versionNumber}`;
const contentPath = `${metadataPath}/content`;
const bindingPath = "/api/runtime-preview/public-bindings";
const applicationCookie = "gate-005-application-cookie";
const applicationStorage = "gate-005-application-storage";

interface ObservedRequest {
  readonly authorization: boolean;
  readonly cookie: boolean;
  readonly csrf: boolean;
  readonly kind: "binding" | "content" | "metadata" | "preview";
  readonly storageCapability: boolean;
}

interface ObservedResponse {
  readonly cacheControl: string | undefined;
  readonly contentTypeOptions: string | undefined;
  readonly coop: string | undefined;
  readonly coep: string | undefined;
  readonly corp: string | undefined;
  readonly kind: ObservedRequest["kind"];
  readonly pathname: string;
  readonly setCookie: string | undefined;
  readonly status: number;
}

const observedRequests: ObservedRequest[] = [];
const observedResponses: ObservedResponse[] = [];
const pendingObservations: Promise<void>[] = [];
const responseStatus = new Map<string, number[]>();
const browserErrors: string[] = [];

const browser = await chromium.launch({
  args: [
    "--host-resolver-rules=MAP *.preview.localhost 127.0.0.1,MAP preview.localhost 127.0.0.1",
    "--no-proxy-server"
  ],
  headless: true
});

try {
  const context = await browser.newContext({ serviceWorkers: "allow" });
  observe(context);
  await context.addCookies([
    { name: "gate_application_cookie", value: applicationCookie, url: origin },
    { name: "nuriteo_dev_csrf", value: `nrt_csrf_${"A".repeat(43)}`, url: origin }
  ]);
  const page = await context.newPage();
  page.on("pageerror", (error) => browserErrors.push(error.message));
  await page.goto(`${origin}${fixedPath}`, { waitUntil: "domcontentloaded" });
  await page.getByText("Fixed snapshot", { exact: true }).waitFor({ timeout: 30_000 });
  await page.getByText(
    `This public view is pinned to version ${identity.versionNumber}.`,
    { exact: false }
  ).waitFor();
  await page.evaluate(({ applicationStorage }) => {
    localStorage.setItem("nuriteo-account-auth", applicationStorage);
    sessionStorage.setItem("nuriteo-csrf-state", applicationStorage);
    return caches.open("nuriteo-application-cache").then((cache) => cache.put(
      "/gate-005-application-marker",
      new Response(applicationStorage)
    ));
  }, { applicationStorage });

  const metadata = await page.evaluate(async ({ metadataPath }) => {
    const response = await fetch(metadataPath, {
      cache: "no-store",
      credentials: "omit",
      headers: { accept: "application/json" },
      redirect: "error"
    });
    return {
      body: await response.json() as Record<string, unknown>,
      cacheControl: response.headers.get("cache-control"),
      setCookie: response.headers.get("set-cookie"),
      status: response.status
    };
  }, { metadataPath });
  assert.equal(metadata.status, 200);
  assert.equal(metadata.setCookie, null);
  assert.equal(metadata.cacheControl, "public, max-age=0, must-revalidate");
  assert.deepEqual(Object.keys(metadata.body).sort(), [
    "name", "publicId", "publishedAt", "versionNumber", "visibility"
  ]);
  assert.equal(metadata.body.publicId, identity.publicId);
  assert.equal(metadata.body.versionNumber, identity.versionNumber);

  const first = await runPreview(page, context);
  await first.frame.evaluate(async ({ applicationCookie, applicationStorage }) => {
    const check = (condition: boolean, message: string) => {
      if (!condition) throw new Error(message);
    };
    check(document.cookie === "", "application cookie crossed into Preview");
    check(localStorage.getItem("nuriteo-account-auth") === null, "application auth storage crossed into Preview");
    check(sessionStorage.getItem("nuriteo-csrf-state") === null, "application CSRF storage crossed into Preview");
    check(!(await caches.keys()).includes("nuriteo-application-cache"), "application cache crossed into Preview");
    check(!document.documentElement.innerHTML.includes(applicationCookie), "application cookie was rendered in Preview");
    check(!document.documentElement.innerHTML.includes(applicationStorage), "application storage was rendered in Preview");
  }, { applicationCookie, applicationStorage });
  assert.equal(await first.frame.evaluate(() => globalThis.crossOriginIsolated), true);
  assert.deepEqual(await previewServiceWorkers(first.frame), [`${first.origin}/runtime-preview/sw.js`]);
  await first.frame.evaluate(() => {
    localStorage.setItem("gate-public-preview-origin", "first-origin-only");
    sessionStorage.setItem("gate-public-preview-session", "first-origin-only");
  });
  const applicationWorkers = context.serviceWorkers()
    .filter((worker) => new URL(worker.url()).origin === origin)
    .map((worker) => worker.url());
  assert.ok(applicationWorkers.every((url) => new URL(url).origin !== first.origin));

  await stopPreview(page, context, first.origin);
  const second = await runPreview(page, context);
  assert.notEqual(second.origin, first.origin, "a fresh public run reused the prior Preview origin");
  assert.equal(await second.frame.evaluate(() => localStorage.getItem("gate-public-preview-origin")), null);
  assert.equal(await second.frame.evaluate(() => sessionStorage.getItem("gate-public-preview-session")), null);
  assert.deepEqual(await previewServiceWorkers(second.frame), [`${second.origin}/runtime-preview/sw.js`]);
  await stopPreview(page, context, second.origin);

  await Promise.all(pendingObservations);
  assert.deepEqual(browserErrors, []);
  for (const kind of ["metadata", "content", "binding", "preview"] as const) {
    assert.ok(observedRequests.some((request) => request.kind === kind), `${kind} boundary was not observed`);
  }
  for (const request of observedRequests) {
    assert.equal(request.cookie, false, `${request.kind} received an application cookie`);
    assert.equal(request.authorization, false, `${request.kind} received Authorization`);
    assert.equal(request.csrf, false, `${request.kind} received CSRF`);
    assert.equal(request.storageCapability, false, `${request.kind} received a storage capability`);
  }
  assert.ok((responseStatus.get("metadata") ?? []).includes(200));
  assert.ok((responseStatus.get("content") ?? []).filter((status) => status === 200).length >= 2);
  assert.ok((responseStatus.get("binding") ?? []).filter((status) => status === 201).length >= 2);
  assert.ok((responseStatus.get("preview") ?? []).some((status) => status === 200));
  for (const response of observedResponses) {
    assert.equal(response.setCookie, undefined, `${response.kind} returned Set-Cookie`);
    if (response.kind === "metadata") {
      assert.equal(response.cacheControl, "public, max-age=0, must-revalidate");
    } else if (response.kind !== "preview") {
      assert.equal(response.cacheControl, "no-store", `${response.kind} cache policy drifted`);
    }
    if (response.kind === "content") {
      assert.equal(response.contentTypeOptions, "nosniff");
      assert.equal(response.corp, "same-origin");
    }
    if (response.kind === "preview") {
      assert.ok([
        "no-store",
        "no-cache",
        "public, max-age=0",
        "public, max-age=31536000, immutable",
      ].includes(response.cacheControl ?? ""),
      `Preview cache policy left the reviewed allowlist: ${response.status} ${response.pathname} ${response.cacheControl ?? "<missing>"}`);
      assert.equal(response.corp, "cross-origin");
      if (response.coep !== undefined) assert.equal(response.coep, "require-corp");
      if (response.coop !== undefined) assert.equal(response.coop, "same-origin");
    }
  }
  assert.ok(observedResponses.some((response) =>
    response.kind === "preview"
    && response.coep === "require-corp"
    && response.coop === "same-origin"
  ), "Preview document isolation headers were not observed");

  const assertions = [
    {
      kind: "database",
      name: "the published immutable Version was resolved from the existing gate Project lineage without mutation",
      status: "PASS"
    },
    {
      kind: "api",
      name: "anonymous metadata, content, binding and Preview boundaries enforced exact cache/isolation headers without cookie, Authorization, CSRF, or storage capability",
      status: "PASS"
    },
    {
      kind: "browser",
      name: "the actual published Bundle rendered through the configured wildcard Preview origin with isolated cookie, storage, cache, and Service Worker state",
      status: "PASS"
    },
    {
      kind: "browser",
      name: "stopping disposed the Preview iframe and Service Worker before a second run received a fresh origin",
      status: "PASS"
    }
  ] as const;
  fs.writeFileSync(output, `${JSON.stringify({ "published-preview": assertions })}\n`, { mode: 0o600 });
  await context.close();
} finally {
  await browser.close();
}

function observe(context: BrowserContext): void {
  context.on("request", (request) => {
    const kind = classify(request);
    if (kind === undefined) return;
    pendingObservations.push(request.allHeaders().then((headers) => {
      const names = Object.keys(headers).map((name) => name.toLowerCase());
      observedRequests.push({
        kind,
        authorization: names.includes("authorization"),
        cookie: names.includes("cookie"),
        csrf: names.includes("x-csrf-token"),
        storageCapability: names.some((name) =>
          name.startsWith("x-amz-")
          || (name.includes("storage") && name !== "sec-fetch-storage-access")
          || name === "x-nuriteo-upload-capability"
        )
      });
    }));
  });
  context.on("response", (response) => {
    const kind = classifyResponse(response);
    if (kind === undefined) return;
    const values = responseStatus.get(kind) ?? [];
    values.push(response.status());
    responseStatus.set(kind, values);
    const headers = response.headers();
    observedResponses.push({
      cacheControl: headers["cache-control"],
      contentTypeOptions: headers["x-content-type-options"],
      coep: headers["cross-origin-embedder-policy"],
      coop: headers["cross-origin-opener-policy"],
      corp: headers["cross-origin-resource-policy"],
      kind,
      pathname: new URL(response.url()).pathname,
      setCookie: headers["set-cookie"],
      status: response.status(),
    });
  });
}

function classify(request: Request): ObservedRequest["kind"] | undefined {
  return classifyUrl(new URL(request.url()));
}

function classifyResponse(response: Response): ObservedRequest["kind"] | undefined {
  return classifyUrl(new URL(response.url()));
}

function classifyUrl(url: URL): ObservedRequest["kind"] | undefined {
  if (url.origin === origin && url.pathname === metadataPath) return "metadata";
  if (url.origin === origin && url.pathname === contentPath) return "content";
  if (url.origin === origin && url.pathname === bindingPath) return "binding";
  if (url.hostname.endsWith(".preview.localhost")) return "preview";
  return undefined;
}

async function runPreview(
  page: import("@playwright/test").Page,
  context: BrowserContext
): Promise<{ frame: Frame; origin: string }> {
  const previous = await page.evaluate(() =>
    document.querySelector("[data-public-preview-url]")?.getAttribute("data-public-preview-url") ?? null
  );
  await page.getByRole("button", { name: "Run isolated Preview" }).click();
  await page.waitForFunction((oldValue) => {
    const current = document.querySelector("[data-public-preview-url]")?.getAttribute("data-public-preview-url");
    return current !== undefined && current !== null && current !== oldValue;
  }, previous, { timeout: 60_000 });
  const previewUrl = await page.locator("[data-public-preview-url]").getAttribute("data-public-preview-url");
  assert.ok(previewUrl);
  assert.match(
    previewUrl,
    /^http:\/\/r-[a-z2-7]{45}-p[1-9][0-9]*\.preview\.localhost:[0-9]+\/runtime-preview\/bootstrap$/u
  );
  const previewOrigin = new URL(previewUrl).origin;
  assert.notEqual(previewOrigin, origin);
  const frame = await waitForFrame(page, previewOrigin);
  await frame.getByRole("button", { name: "saved through the bundled relay:1" })
    .waitFor({ timeout: 60_000 });
  await waitFor(() => context.serviceWorkers().some((worker) =>
    worker.url() === `${previewOrigin}/runtime-preview/sw.js`
  ));
  return { frame, origin: previewOrigin };
}

async function stopPreview(
  page: import("@playwright/test").Page,
  context: BrowserContext,
  previewOrigin: string
): Promise<void> {
  await page.getByRole("button", { name: "Stop Preview" }).click();
  await page.getByRole("button", { name: "Run isolated Preview" }).waitFor({ timeout: 30_000 });
  await page.locator("[data-public-preview-url]").waitFor({ state: "detached", timeout: 30_000 });
  await waitForPreviewUnregistration(context, previewOrigin);
}

async function waitForPreviewUnregistration(
  context: BrowserContext,
  previewOrigin: string
): Promise<void> {
  const probe = await context.newPage();
  try {
    await probe.goto(`${previewOrigin}/runtime-preview/sw.js`, { waitUntil: "domcontentloaded" });
    const deadline = Date.now() + 20_000;
    while (await probe.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length > 0)) {
      if (Date.now() >= deadline) throw new Error("timed out waiting for Preview disposal");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  } finally {
    await probe.close();
  }
}

async function previewServiceWorkers(frame: Frame): Promise<string[]> {
  return frame.evaluate(async () => (await navigator.serviceWorker.getRegistrations())
    .map((registration) => registration.active?.scriptURL ?? "")
    .filter(Boolean)
    .sort());
}

async function waitFor(predicate: () => boolean, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for Preview disposal");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function waitForFrame(page: import("@playwright/test").Page, previewOrigin: string): Promise<Frame> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const frame = page.frames().find((candidate) => {
      try {
        const url = new URL(candidate.url());
        return url.origin === previewOrigin && url.pathname === "/";
      } catch {
        return false;
      }
    });
    if (frame !== undefined) return frame;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("isolated Preview frame was not attached");
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
