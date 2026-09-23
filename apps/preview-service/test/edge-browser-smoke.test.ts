import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const appRoot = path.join(root, "apps/preview-service");
const edgePath = process.env.EDGE_PATH || "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge";
const port = 5193;
const baseUrl = `http://127.0.0.1:${port}`;
const viteBin = path.join(appRoot, "node_modules/.bin/vite");

assert.ok(fs.existsSync(edgePath), `Microsoft Edge not found at ${edgePath}`);

const server = spawn(viteBin, ["--host", "127.0.0.1", "--port", String(port), "--strictPort"], {
  cwd: appRoot,
  env: { ...process.env },
  stdio: ["ignore", "pipe", "pipe"]
});

await waitForServer();
const browser = await chromium.launch({ executablePath: edgePath, headless: true });
const page = await browser.newPage();

try {
  const response = await page.goto(baseUrl, { waitUntil: "networkidle" });
  assert.ok(response, "Edge navigation must return a response");
  assert.equal(response.headers()["cross-origin-opener-policy"], "same-origin");
  assert.equal(response.headers()["cross-origin-embedder-policy"], "require-corp");

  const platform = await page.evaluate(() => ({
    crossOriginIsolated: globalThis.crossOriginIsolated,
    hasSharedArrayBuffer: typeof globalThis.SharedArrayBuffer === "function",
    hasServiceWorker: "serviceWorker" in navigator,
    userAgent: navigator.userAgent
  }));
  assert.match(platform.userAgent, /Edg\//, "smoke must run in Microsoft Edge");
  assert.equal(platform.crossOriginIsolated, true, "Edge must preserve COOP/COEP isolation");
  assert.equal(platform.hasSharedArrayBuffer, true, "Edge must expose SharedArrayBuffer");
  assert.equal(platform.hasServiceWorker, true, "Edge must expose Service Worker support");

  await page.waitForFunction(() => Boolean(globalThis.__previewService), null, { timeout: 30_000 });
  await page.click("#welcome-start");
  await page.evaluate(() => globalThis.__previewService.loadTemplate("vite-react"));
  await page.click("#run-preview");
  await page.waitForFunction(() => {
    const phase = globalThis.__previewService.snapshot().phase;
    return phase === "preview_ready" || phase === "hmr_connected";
  }, null, { timeout: 60_000 });

  await page.frameLocator("#preview-frame").locator("#app").waitFor({ timeout: 20_000 });
  const registration = await page.evaluate(async () => {
    const ready = await navigator.serviceWorker.ready;
    return { active: Boolean(ready.active), scope: ready.scope };
  });
  assert.equal(registration.active, true, "preview Service Worker must activate in Edge");
  assert.equal(registration.scope, `${baseUrl}/`);

  console.log(`preview service Edge smoke ok userAgent=${platform.userAgent}`);
} finally {
  await browser.close();
  server.kill("SIGTERM");
}

function waitForServer() {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("preview-service Edge smoke start timeout")), 60_000);
    const onData = (chunk) => {
      const output = String(chunk);
      if (output.includes("Local:") || output.includes(baseUrl)) {
        clearTimeout(timer);
        resolve();
      }
    };
    server.stdout.on("data", onData);
    server.stderr.on("data", (chunk) => {
      process.stderr.write(chunk);
      onData(chunk);
    });
    server.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`preview-service Edge smoke exited early: ${code}`));
    });
  });
}
