import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const appRoot = path.join(root, "apps/preview-service");
const chromePath = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const port = 5193;
const baseUrl = `http://127.0.0.1:${port}`;
const viteBin = path.join(appRoot, "node_modules/.bin/vite");
const server = spawn(viteBin, ["--host", "127.0.0.1", "--port", String(port), "--strictPort"], {
  cwd: appRoot,
  env: { ...process.env },
  stdio: ["ignore", "pipe", "pipe"]
});

await waitForServer();
const browser = await chromium.launch({ executablePath: chromePath, headless: true });
const page = await browser.newPage();

try {
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.click("#welcome-start");
  await page.waitForFunction(() => Boolean(globalThis.__previewService), null, { timeout: 30_000 });

  const projectRoot = await page.evaluate(() => {
    const api = globalThis.__previewService;
    api.loadTemplate("vite-react");
    const { editor, project } = api.snapshot();
    editor.createFile(`${project.root}/.gitignore`, "*.log\n!keep.log\nignored/\n");
    editor.createFile(`${project.root}/debug.log`, "hidden");
    editor.createFile(`${project.root}/keep.log`, "visible");
    editor.createFile(`${project.root}/ignored/nested.ts`, "hidden");
    api.openFile(`${project.root}/keep.log`);
    return project.root;
  });

  const gitignore = page.locator(`[data-path="${projectRoot}/.gitignore"]`);
  const ignoredFile = page.locator(`[data-path="${projectRoot}/debug.log"]`);
  const restoredFile = page.locator(`[data-path="${projectRoot}/keep.log"]`);
  await gitignore.waitFor();
  await restoredFile.waitFor();
  assert.equal(await ignoredFile.count(), 0, "ignored files must be hidden by default");
  assert.equal(await page.getByText("ignored", { exact: true }).count(), 0, "ignored directories must be hidden");

  await page.locator("#file-filter").fill("debug");
  assert.equal(await ignoredFile.count(), 0, "search must not reveal ignored files while hidden");

  const toggle = page.locator("#file-toggle-ignored");
  assert.equal(await toggle.getAttribute("aria-pressed"), "false");
  await toggle.click();
  assert.equal(await toggle.getAttribute("aria-pressed"), "true");
  await ignoredFile.waitFor();
  await ignoredFile.click();
  assert.equal(await ignoredFile.getAttribute("aria-current"), "true", "shown ignored files remain selectable");

  await page.locator("#file-filter").fill("");
  await page.getByText("ignored", { exact: true }).waitFor();
  await toggle.click();
  assert.equal(await ignoredFile.count(), 0);
  await gitignore.waitFor();

  console.log("preview service gitignore explorer ok");
} finally {
  await browser.close();
  server.kill("SIGTERM");
}

function waitForServer() {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("preview-service Vite start timeout")), 60_000);
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
      reject(new Error(`preview-service Vite exited early: ${code}`));
    });
  });
}
