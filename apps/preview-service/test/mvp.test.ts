import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const appRoot = path.join(root, "apps/preview-service");
const chromePath = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const port = 5187;
const baseUrl = `http://127.0.0.1:${port}`;
const viteBin = path.join(appRoot, "node_modules/.bin/vite");

const server = spawn(viteBin, ["--host", "127.0.0.1", "--port", String(port), "--strictPort"], {
  cwd: appRoot,
  env: { ...process.env },
  stdio: ["ignore", "pipe", "pipe"]
});

await waitForServer();

const browser = await chromium.launch({
  executablePath: chromePath,
  headless: true
});
const page = await browser.newPage();

try {
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.waitForFunction(() => Boolean(globalThis.__previewService), null, { timeout: 30_000 });

  await page.click("#welcome-start");
  await page.waitForFunction(() => {
    const snapshot = globalThis.__previewService.snapshot();
    return snapshot.phase === "preview_ready"
      || snapshot.phase === "hmr_connected"
      || snapshot.phase === "template_loaded";
  }, null, { timeout: 60_000 });

  await page.evaluate(() => globalThis.__previewService.loadTemplate("vite-react"));
  await page.waitForFunction(() => globalThis.__previewService.snapshot().phase === "template_loaded");

  const zipRoundTrip = await page.evaluate(async () => {
    const bytes = globalThis.__previewService.exportZip();
    const file = new File([bytes], "project.zip", { type: "application/zip" });
    await globalThis.__previewService.importZipFile(file);
    const snapshot = globalThis.__previewService.snapshot();
    return {
      phase: snapshot.phase,
      source: snapshot.source,
      ok: snapshot.health?.ok === true,
      manager: snapshot.health?.detection?.packageManager
    };
  });
  assert.equal(zipRoundTrip.source, "zip");
  assert.equal(zipRoundTrip.ok, true);
  assert.equal(zipRoundTrip.manager, "pnpm");

  // GitHub archive materialize is covered by packages/browser-host/test/project-onboarding.test.ts.
  assert.equal(await page.evaluate(() => typeof globalThis.__previewService.importGitHub), "function");

  await page.evaluate(() => globalThis.__previewService.loadTemplate("vite-react"));
  await page.waitForFunction(() => globalThis.__previewService.snapshot().phase === "template_loaded");

  await page.click("#run-preview");
  await page.waitForFunction(() => {
    const snapshot = globalThis.__previewService.snapshot();
    return snapshot.phase === "preview_ready" || snapshot.phase === "hmr_connected";
  }, null, { timeout: 60_000 });

  const previewUrl = await page.evaluate(() => globalThis.__previewService.snapshot().previewUrl);
  assert.match(previewUrl, /\/__preview\/preview-service\/5173\//);

  await page.waitForFunction(() => {
    const frame = document.getElementById("preview-frame");
    return Boolean(frame?.src?.includes("/__preview/"));
  }, null, { timeout: 15_000 });

  await page.waitForTimeout(800);
  const frame = page.frameLocator("#preview-frame");
  await frame.locator("#app").waitFor({ timeout: 20_000 });
  const before = await frame.locator("#app").innerText();
  assert.match(before, /nuriteo:\d+/);

  const messagePath = await page.evaluate(() => {
    const files = globalThis.__previewService.snapshot().project.listFiles();
    const message = files.find((file) => file.path.endsWith("message.ts"))
      || files.find((file) => file.path.endsWith("message.js"));
    return message.path;
  });
  await page.evaluate(async (path) => {
    globalThis.__previewService.openFile(path);
    const editor = globalThis.__previewService.snapshot().editor;
    editor.editText(path, 'export const label = "beta";\n');
    globalThis.__previewService.saveCurrentFile();
  }, messagePath);

  await page.frameLocator("#preview-frame").locator("#app").filter({ hasText: "beta:" }).waitFor({ timeout: 20_000 });

  await page.click("#run-build");
  await page.waitForFunction(() => globalThis.__previewService.snapshot().phase === "built", null, { timeout: 20_000 });

  await page.click("#restart-dev");
  await page.waitForFunction(() => {
    const snapshot = globalThis.__previewService.snapshot();
    return snapshot.phase === "preview_ready" || snapshot.phase === "hmr_connected";
  }, null, { timeout: 20_000 });

  console.log("preview service mvp ok");
} finally {
  await browser.close();
  server.kill("SIGTERM");
}
function waitForServer() {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("preview-service vite start timeout")), 60_000);
    const onData = (chunk) => {
      const text = String(chunk);
      if (text.includes("Local:") || text.includes(`http://127.0.0.1:${port}`)) {
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
      reject(new Error(`preview-service vite exited early: ${code}`));
    });
  });
}
