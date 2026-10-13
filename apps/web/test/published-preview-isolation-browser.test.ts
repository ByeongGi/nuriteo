import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "@playwright/test";
import { build } from "esbuild";

import { issueSignedPreviewBinding, verifySignedPreviewBinding } from "../src/lib/preview/signed-binding.ts";
import { previewBootstrapDocument } from "../src/runtime/preview-bootstrap-document.ts";
import { parsePreviewHost } from "../src/runtime/preview-origin-contract.ts";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicRoot = path.join(webRoot, "public");
const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nuriteo-published-preview-"));
await build({
  bundle: true,
  entryPoints: [path.join(webRoot, "test/fixtures/published-preview.tsx")],
  format: "esm",
  jsx: "automatic",
  outfile: path.join(fixtureRoot, "fixture.js"),
  platform: "browser",
  target: "es2022"
});
fs.writeFileSync(
  path.join(fixtureRoot, "index.html"),
  '<!doctype html><meta charset="utf-8"><div id="root"></div><script type="module" src="/fixture.js"></script>\n'
);

const signingKey = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const exampleId = "ExESEhISEhISEhISEhISEhISEhISEhISEhISEhISEgA";
const archive = createPublicArchive([
  { path: "index.html", data: '<!doctype html><main id="public-preview">loading</main><script type="module" src="/src/main.js"></script>\n' },
  { path: "package.json", data: '{"name":"published-preview","private":true,"scripts":{"dev":"vite --host 127.0.0.1"},"devDependencies":{"vite":"^6.2.0"}}\n' },
  { path: "src/main.js", data: 'document.querySelector("#public-preview").textContent = "immutable public preview";\n' }
]);
const archiveDigest = createHash("sha256").update(archive).digest("base64url");
const requests: Array<{
  authorization: string | undefined;
  cookie: string | undefined;
  csrf: string | undefined;
  kind: string;
}> = [];
let applicationOrigin = "";

const server = http.createServer((request, response) => {
  const host = (request.headers.host ?? "").replace(/:\d+$/u, "").toLowerCase();
  const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
  if (host === "app.localhost") {
    if (pathname === `/api/v1/published-examples/${exampleId}/versions/3/content`) {
      requests.push(requestRecord("content", request));
      response.writeHead(200, {
        "Cache-Control": "no-store",
        "Content-Length": String(archive.byteLength),
        "Content-Type": "application/vnd.nuriteo.published-project-bundle",
        "Cross-Origin-Resource-Policy": "same-origin",
        ETag: `"published-content-v3-${archiveDigest}"`,
        "X-Content-Type-Options": "nosniff"
      }).end(archive);
      return;
    }
    if (pathname === "/api/runtime-preview/public-bindings" && request.method === "POST") {
      requests.push(requestRecord("binding", request));
      void issuePublicBinding(request, response);
      return;
    }
    serveApplication(pathname, response);
    return;
  }

  const binding = parsePreviewHost(host, "preview.localhost");
  if (binding === null) {
    response.writeHead(404).end("not found");
    return;
  }
  requests.push(requestRecord("preview", request));
  void verifySignedPreviewBinding(signingKey, binding.runtimeId, binding.port).then((verification) => {
    if (verification !== "valid") {
      response.writeHead(verification === "expired" ? 410 : 404).end("not found");
      return;
    }
    if (pathname === "/runtime-preview/bootstrap") {
      response.writeHead(200, previewHeaders("text/html; charset=utf-8"));
      response.end(previewBootstrapDocument({
        applicationOrigin,
        binding: binding.label,
        runtimeId: binding.runtimeId
      }));
      return;
    }
    if (["/runtime-preview/bootstrap.js", "/runtime-preview/hmr.js", "/runtime-preview/sw.js"].includes(pathname)) {
      response.writeHead(200, {
        ...previewHeaders("text/javascript; charset=utf-8"),
        "Service-Worker-Allowed": "/"
      });
      response.end(fs.readFileSync(path.join(publicRoot, pathname)));
      return;
    }
    response.writeHead(404).end("not found");
  });
});

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert(address && typeof address !== "string");
applicationOrigin = `http://app.localhost:${address.port}`;
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext();
  await context.addCookies([
    { name: "nuriteo_session", value: "must-not-cross-public-boundary", url: applicationOrigin },
    { name: "nuriteo_dev_csrf", value: `nrt_csrf_${"A".repeat(43)}`, url: applicationOrigin }
  ]);
  const page = await context.newPage();
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(applicationOrigin, { waitUntil: "domcontentloaded" });
  await page.evaluate(() => {
    localStorage.setItem("nuriteo-account-secret", "must-not-cross-origin");
    sessionStorage.setItem("nuriteo-session-secret", "must-not-cross-origin");
  });

  await page.getByRole("button", { name: "Run isolated Preview" }).click();
  const firstUrl = await waitForPreviewUrl(page);
  const firstOrigin = new URL(firstUrl).origin;
  const firstFrame = await waitForFrame(page, firstOrigin);
  await firstFrame.getByText("immutable public preview").waitFor({ timeout: 20_000 });
  assert.notEqual(firstOrigin, applicationOrigin);
  assert.match(firstOrigin, /^http:\/\/r-[a-z2-7]{45}-p[1-9][0-9]*\.preview\.localhost:\d+$/u);
  assert.equal(await firstFrame.evaluate(() => document.cookie), "");
  assert.equal(await firstFrame.evaluate(() => localStorage.getItem("nuriteo-account-secret")), null);
  assert.equal(await firstFrame.evaluate(() => sessionStorage.getItem("nuriteo-session-secret")), null);
  assert.equal(await firstFrame.evaluate(() => globalThis.crossOriginIsolated), true);
  assert.equal(await firstFrame.evaluate(() => navigator.serviceWorker.controller?.scriptURL), `${firstOrigin}/runtime-preview/sw.js`);
  await firstFrame.evaluate(() => localStorage.setItem("public-preview-marker", "first-origin-only"));

  await page.getByRole("button", { name: "Stop Preview" }).click();
  await page.getByRole("button", { name: "Run isolated Preview" }).waitFor({ timeout: 10_000 });
  await page.waitForFunction(() => (window as unknown as {
    __nuriteoPublicPreviewProbe: { activeWorkers: number };
  }).__nuriteoPublicPreviewProbe.activeWorkers === 0);
  await page.getByRole("button", { name: "Run isolated Preview" }).click();
  const secondUrl = await waitForPreviewUrl(page, firstUrl);
  const secondOrigin = new URL(secondUrl).origin;
  const secondFrame = await waitForFrame(page, secondOrigin);
  await secondFrame.getByText("immutable public preview").waitFor({ timeout: 20_000 });
  assert.notEqual(secondOrigin, firstOrigin, "each public run must receive a fresh storage and Service Worker origin");
  assert.equal(await secondFrame.evaluate(() => localStorage.getItem("public-preview-marker")), null);
  assert.equal(await secondFrame.evaluate(() => navigator.serviceWorker.controller?.scriptURL), `${secondOrigin}/runtime-preview/sw.js`);

  for (const request of requests.filter((item) => item.kind === "content" || item.kind === "binding" || item.kind === "preview")) {
    assert.equal(request.cookie, undefined, `${request.kind} request leaked application cookies`);
    assert.equal(request.authorization, undefined, `${request.kind} request leaked Authorization`);
    assert.equal(request.csrf, undefined, `${request.kind} request leaked CSRF`);
  }
  assert.ok(requests.some((request) => request.kind === "content"));
  assert.ok(requests.some((request) => request.kind === "binding"));
  assert.ok(requests.some((request) => request.kind === "preview"));

  await page.getByRole("button", { name: "Stop Preview" }).click();
  await page.getByRole("button", { name: "Run isolated Preview" }).waitFor({ timeout: 10_000 });
  await page.waitForFunction(() => (window as unknown as {
    __nuriteoPublicPreviewProbe: { activeWorkers: number };
  }).__nuriteoPublicPreviewProbe.activeWorkers === 0);
  assert.deepEqual(pageErrors, []);
  console.log("PUB-003 public Preview isolation browser matrix ok");
} finally {
  await browser.close();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  fs.rmSync(fixtureRoot, { force: true, recursive: true });
}

async function issuePublicBinding(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
  if (
    request.headers.origin !== applicationOrigin
    || request.headers["content-type"] !== "application/json"
    || parsed.publicId !== exampleId
    || parsed.versionNumber !== 3
    || !Number.isInteger(parsed.port)
  ) {
    response.writeHead(403).end("rejected");
    return;
  }
  const binding = await issueSignedPreviewBinding(signingKey, parsed.port as number);
  response.writeHead(201, { "Cache-Control": "no-store", "Content-Type": "application/json" });
  response.end(JSON.stringify({
    runtimeId: binding.runtimeId,
    ttlMs: Math.max(1, binding.expiresAt - Date.now())
  }));
}

function requestRecord(kind: string, request: http.IncomingMessage) {
  return {
    kind,
    authorization: request.headers.authorization,
    cookie: request.headers.cookie,
    csrf: request.headers["x-csrf-token"] as string | undefined
  };
}

function serveApplication(pathname: string, response: http.ServerResponse): void {
  response.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  const root = pathname.startsWith("/runtime/") ? publicRoot : fixtureRoot;
  const relative = pathname === "/" ? "index.html" : pathname.slice(1);
  const resolved = path.resolve(root, relative);
  if (!resolved.startsWith(`${root}${path.sep}`) || !fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    response.writeHead(404).end("not found");
    return;
  }
  if (pathname.endsWith("preview-sw.js")) response.setHeader("Service-Worker-Allowed", "/");
  response.setHeader("Content-Type", contentType(resolved));
  response.end(fs.readFileSync(resolved));
}

function previewHeaders(contentTypeValue: string): Record<string, string> {
  return {
    "Cache-Control": "no-store",
    "Content-Security-Policy": `default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; worker-src 'self'; frame-src 'self'; connect-src 'self'; frame-ancestors 'self' ${applicationOrigin}; base-uri 'none'; form-action 'none'`,
    "Content-Type": contentTypeValue,
    "Cross-Origin-Embedder-Policy": "require-corp",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "cross-origin",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff"
  };
}

function contentType(file: string): string {
  if (file.endsWith(".html")) return "text/html; charset=utf-8";
  if (file.endsWith(".js") || file.endsWith(".mjs")) return "text/javascript; charset=utf-8";
  if (file.endsWith(".wasm")) return "application/wasm";
  if (file.endsWith(".json")) return "application/json; charset=utf-8";
  return "application/octet-stream";
}

async function waitForPreviewUrl(page: import("@playwright/test").Page, previous?: string): Promise<string> {
  await page.waitForFunction((oldValue) => {
    const value = document.querySelector("[data-public-preview-url]")?.getAttribute("data-public-preview-url");
    return value !== null && value !== oldValue;
  }, previous ?? null, { timeout: 30_000 });
  const value = await page.locator("[data-public-preview-url]").getAttribute("data-public-preview-url");
  assert(value);
  return value;
}

async function waitForFrame(page: import("@playwright/test").Page, origin: string): Promise<import("@playwright/test").Frame> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const frame = page.frames().find((candidate) => {
      try {
        return new URL(candidate.url()).origin === origin && new URL(candidate.url()).pathname === "/";
      } catch {
        return false;
      }
    });
    if (frame !== undefined) return frame;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Preview frame at ${origin} was not attached`);
}

interface ArchiveFile { readonly data: string; readonly path: string }

function createPublicArchive(files: readonly ArchiveFile[]): Buffer {
  const manifestFiles = files.map((file) => {
    const data = Buffer.from(file.data);
    return { path: file.path, kind: "text", mode: "0644", sizeBytes: data.byteLength, sha256: createHash("sha256").update(data).digest("hex") };
  });
  const manifest = Buffer.from(`${JSON.stringify({
    format: "nuriteo-published-bundle-v1",
    schemaVersion: 1,
    fileCount: files.length,
    logicalBytes: files.reduce((total, file) => total + Buffer.byteLength(file.data), 0),
    files: manifestFiles
  })}\n`);
  const chunks = [tarEntry("manifest.json", manifest, 0o644, "0")];
  files.forEach((file, index) => {
    const sequence = index.toString().padStart(8, "0");
    chunks.push(tarEntry(`PaxHeaders/${sequence}`, pax(`files/${file.path}`), 0o644, "x"));
    chunks.push(tarEntry(`files/${sequence}`, Buffer.from(file.data), 0o644, "0"));
  });
  chunks.push(Buffer.alloc(1024));
  return Buffer.concat(chunks);
}

function tarEntry(name: string, content: Buffer, mode: number, type: "0" | "x"): Buffer {
  const header = Buffer.alloc(512);
  header.write(name);
  writeOctal(header, 100, 8, mode);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, content.byteLength);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = type.charCodeAt(0);
  header.write("ustar\0", 257);
  header.write("00", 263);
  const checksum = [...header].reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, "0");
  header.write(checksum, 148);
  header[154] = 0;
  header[155] = 0x20;
  return Buffer.concat([header, content, Buffer.alloc(Math.ceil(content.byteLength / 512) * 512 - content.byteLength)]);
}

function pax(pathname: string): Buffer {
  let size = Buffer.byteLength(`path=${pathname}\n`) + 2;
  while (true) {
    const record = Buffer.from(`${size} path=${pathname}\n`);
    if (record.byteLength === size) return record;
    size = record.byteLength;
  }
}

function writeOctal(target: Buffer, offset: number, length: number, value: number): void {
  target.write(value.toString(8).padStart(length - 1, "0"), offset);
  target[offset + length - 1] = 0;
}
