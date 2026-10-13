import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "@playwright/test";
import { build } from "esbuild";

declare global {
  interface Window {
    __runtimeRecoveryFixture: {
      failPreview(): void;
      resolvePendingBridge(): void;
      snapshot(): { bridgeAttempts: number; bridgeCreationPending: boolean; disposedBridges: number };
      unmount(): void;
    };
  }
}

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nuriteo-runtime-recovery-"));
await build({
  bundle: true,
  entryPoints: [path.join(webRoot, "test/fixtures/runtime-recovery.tsx")],
  format: "esm",
  jsx: "automatic",
  outfile: path.join(fixtureRoot, "fixture.js"),
  platform: "browser",
  target: "es2022"
});
fs.writeFileSync(path.join(fixtureRoot, "index.html"), '<!doctype html><meta charset="utf-8"><div id="root"></div><script type="module" src="/fixture.js"></script>\n');

const server = http.createServer((request, response) => {
  const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
  const file = pathname === "/" ? "index.html" : pathname.slice(1);
  const resolved = path.resolve(fixtureRoot, file);
  if (!resolved.startsWith(`${fixtureRoot}${path.sep}`) || !fs.existsSync(resolved)) {
    response.writeHead(404).end("not found");
    return;
  }
  response.setHeader("Content-Type", file.endsWith(".js") ? "text/javascript; charset=utf-8" : "text/html; charset=utf-8");
  response.end(fs.readFileSync(resolved));
});

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert(address && typeof address !== "string");
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(`http://127.0.0.1:${address.port}/`, { waitUntil: "domcontentloaded" });

  await page.getByRole("button", { name: "Start workspace" }).click();
  await page.getByText("The browser workspace could not be started safely.").waitFor();
  await page.getByRole("button", { name: "Start workspace" }).click();

  await page.getByRole("region", { name: "Workspace recovery" }).waitFor();
  assert.equal(await page.getByLabel("Editor for src/message.ts").isEditable(), false);
  await page.getByRole("button", { name: "Take over writer lease" }).click();
  await page.getByRole("alertdialog").waitFor();
  await page.getByRole("button", { name: "Confirm writer takeover" }).click();
  await page.getByText("Writer lease acquired · Local Draft preserved", { exact: false }).waitFor();
  assert.equal(await page.getByLabel("Editor for src/message.ts").isEditable(), true);

  const editor = page.getByLabel("Editor for src/message.ts");
  await editor.fill('export const label = "quota-trigger";\n');
  await page.getByRole("button", { name: "Apply to Local Draft" }).click();
  await page.getByText("EOPFSQUOTA", { exact: false }).waitFor();
  assert.match(await editor.inputValue(), /quota-trigger/u, "quota failure must preserve unsaved editor text");
  await page.getByRole("button", { name: "Clear package cache" }).click();
  await page.getByText("Package cache cleared · Local Draft preserved", { exact: false }).waitFor();
  await page.getByRole("button", { name: "Apply to Local Draft" }).click();
  await page.getByText("Local Draft saved", { exact: false }).waitFor();

  await page.getByRole("button", { name: "Run Preview" }).click();
  await page.locator('iframe[title="Runtime Recovery Preview"]').waitFor();
  assert.equal(await page.getByRole("region", { name: "Preview" }).getAttribute("data-preview-url"), "about:blank");
  await page.evaluate(() => {
    window.__runtimeRecoveryFixture.failPreview();
  });
  await page.getByText("RUNTIME_PREVIEW_FAILED", { exact: false }).waitFor();
  await page.getByRole("button", { name: "Retry Preview" }).click();
  await page.getByText("Recovery did not complete.", { exact: false }).waitFor();
  assert.equal(await page.locator('iframe[title="Runtime Recovery Preview"]').count(), 0, "a failed replacement must not retain the disposed iframe");
  assert.equal(await page.getByRole("region", { name: "Preview" }).getAttribute("data-preview-url"), null);
  assert.equal(await page.evaluate(() => window.__runtimeRecoveryFixture.snapshot().disposedBridges), 1);

  await page.getByRole("button", { name: "Run Preview" }).click();
  await page.locator('iframe[title="Runtime Recovery Preview"]').waitFor();
  assert.equal(await page.getByRole("region", { name: "Preview" }).getAttribute("data-preview-url"), "about:blank");
  assert.deepEqual(pageErrors, []);

  const unmountPage = await browser.newPage();
  const unmountPageErrors: string[] = [];
  unmountPage.on("pageerror", (error) => unmountPageErrors.push(error.message));
  await unmountPage.goto(`http://127.0.0.1:${address.port}/?mode=unmount`, { waitUntil: "domcontentloaded" });
  await unmountPage.getByRole("button", { name: "Start workspace" }).click();
  await unmountPage.getByRole("button", { name: "Run Preview" }).click();
  await unmountPage.waitForFunction(() => window.__runtimeRecoveryFixture.snapshot().bridgeCreationPending);
  await unmountPage.evaluate(() => {
    const control = window.__runtimeRecoveryFixture;
    control.unmount();
    control.resolvePendingBridge();
  });
  await unmountPage.waitForFunction(() => window.__runtimeRecoveryFixture.snapshot().disposedBridges === 1);
  assert.equal(await unmountPage.locator("#root").textContent(), "");
  assert.equal(await unmountPage.locator("iframe").count(), 0);
  assert.deepEqual(unmountPageErrors, []);
  await unmountPage.close();

  console.log("RT-005 browser recovery journey ok (lazy retry, writer takeover, quota preservation, failed bridge replacement, unmount disposal)");
} finally {
  await browser.close();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  fs.rmSync(fixtureRoot, { force: true, recursive: true });
}
