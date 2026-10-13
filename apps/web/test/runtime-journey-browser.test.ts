import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "@playwright/test";
import { build } from "esbuild";

declare global {
  interface Window { __nuriteoRuntimeProbe: { activeWorkers: number; createdWorkers: number; committedVersion?: number; committedEtag?: string; reloads: number; restoreMode: "download-failure" | "intervening" | "materialization-failure" | "success" } }
}

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicRoot = path.join(webRoot, "public");
const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nuriteo-runtime-browser-"));
await build({
  bundle: true,
  entryPoints: [path.join(webRoot, "test/fixtures/runtime-journey.tsx")],
  format: "esm",
  jsx: "automatic",
  outfile: path.join(fixtureRoot, "fixture.js"),
  platform: "browser",
  target: "es2022"
});
fs.writeFileSync(path.join(fixtureRoot, "index.html"), '<!doctype html><meta charset="utf-8"><div id="root"></div><script type="module" src="/fixture.js"></script>\n');

const server = http.createServer((request, response) => {
  response.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
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
});

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert(address && typeof address !== "string");
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${address.port}/`, { waitUntil: "domcontentloaded" });
  assert.equal(await page.evaluate(() => globalThis.crossOriginIsolated), true);

  await page.getByRole("button", { name: "Start workspace" }).click();
  await page.getByRole("button", { name: "Run Preview" }).waitFor({ timeout: 20_000 });
  assert.equal(await page.evaluate(() => window.__nuriteoRuntimeProbe.createdWorkers), 2);

  await page.getByRole("button", { name: "Run Preview" }).click();
  await page.getByText("Same-origin Preview is disabled.", { exact: false }).waitFor({ timeout: 20_000 });
  const previewUrl = await page.getByRole("region", { name: "Preview" }).getAttribute("data-preview-url");
  assert(previewUrl && previewUrl.includes("/__preview/"));
  const initialPreview = await page.evaluate(async (url) => (await fetch(url)).text(), previewUrl);
  assert.match(initialPreview, /nuriteo:1/u);

  await page.getByRole("button", { name: "src/message.ts" }).click();
  const editor = page.getByLabel("Editor for src/message.ts");
  await editor.fill('export const label = "RT004 edited";\n');
  await page.getByRole("button", { name: "Apply to Local Draft" }).click();
  await page.getByText("Local Draft saved · HMR applied", { exact: false }).waitFor({ timeout: 10_000 });
  const updatedPreview = await page.evaluate(async (url) => (await fetch(url)).text(), previewUrl);
  assert.match(updatedPreview, /RT004 edited:1/u);

  await page.getByRole("button", { name: "Stop workspace" }).click();
  await page.getByRole("button", { name: "Start workspace" }).waitFor({ timeout: 10_000 });
  await page.waitForFunction(() => window.__nuriteoRuntimeProbe.activeWorkers === 0);
  assert.deepEqual(errors, []);
  console.log("RT-004 actual browser journey ok (install, dev, Preview, edit, HMR, dispose)");
} finally {
  await browser.close();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  fs.rmSync(fixtureRoot, { force: true, recursive: true });
}

function contentType(file: string): string {
  if (file.endsWith(".html")) return "text/html; charset=utf-8";
  if (file.endsWith(".js") || file.endsWith(".mjs")) return "text/javascript; charset=utf-8";
  if (file.endsWith(".wasm")) return "application/wasm";
  if (file.endsWith(".json")) return "application/json; charset=utf-8";
  return "application/octet-stream";
}
