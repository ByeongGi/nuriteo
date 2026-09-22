import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const appRoot = path.join(root, "apps/preview-service");
const chromePath = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const port = 5292;
const baseUrl = `http://127.0.0.1:${port}`;
const viteBin = path.join(appRoot, "node_modules/.bin/vite");
const server = spawn(viteBin, ["--host", "127.0.0.1", "--port", String(port), "--strictPort"], {
  cwd: appRoot,
  env: { ...process.env },
  stdio: ["ignore", "pipe", "pipe"]
});

await waitForServer();
const browser = await chromium.launch({ executablePath: chromePath, headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

try {
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.waitForFunction(() => Boolean(globalThis.__previewService));
  const menuBar = page.getByRole("menubar", { name: "Application menu" });
  const fileTrigger = menuBar.getByRole("menuitem", { name: "File" });
  await fileTrigger.focus();
  await page.keyboard.press("Enter");

  const fileMenu = page.getByRole("menu");
  await fileMenu.getByRole("menuitem", { name: /Import Project/ }).waitFor();
  assert.equal(await fileMenu.getByRole("menuitem", { name: /Save File/ }).getAttribute("aria-disabled"), "true");
  assert.equal(await fileMenu.getByRole("menuitem", { name: /New File/ }).getAttribute("aria-disabled"), "true");
  assert.equal(await fileMenu.getByRole("menuitem", { name: /Export ZIP/ }).getAttribute("aria-disabled"), "true");
  assert.notEqual(await fileMenu.getByRole("menuitem", { name: /Import Project/ }).getAttribute("aria-disabled"), "true");

  await page.keyboard.press("Escape");
  await fileMenu.waitFor({ state: "hidden" });
  assert.equal(await fileTrigger.evaluate((element) => element === document.activeElement), true);

  await fileTrigger.focus();
  await page.keyboard.press("ArrowRight");
  const editTrigger = menuBar.getByRole("menuitem", { name: "Edit" });
  assert.equal(await editTrigger.evaluate((element) => element === document.activeElement), true);
  await page.keyboard.press("Enter");
  await page.getByRole("menuitem", { name: "Command Palette…" }).click();
  await page.getByRole("dialog", { name: "Command palette" }).waitFor();
  await page.keyboard.press("Escape");

  await page.evaluate(() => globalThis.__previewService.loadTemplate("vite-react"));
  await page.locator("#welcome").waitFor({ state: "hidden" });

  const viewTrigger = menuBar.getByRole("menuitem", { name: "View" });
  await viewTrigger.click();
  await page.mouse.click(1400, 880);
  await page.getByRole("menu").waitFor({ state: "hidden" });

  await viewTrigger.focus();
  await page.keyboard.press("Enter");
  await page.getByRole("menuitem", { name: /Toggle Terminal/ }).click();

  await fileTrigger.click();
  assert.notEqual(await page.getByRole("menuitem", { name: /Export ZIP/ }).getAttribute("aria-disabled"), "true");

  console.log("preview service application menu ok");
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
