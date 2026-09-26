import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const appRoot = path.join(root, "apps/preview-service");
const chromePath = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const port = 5191;
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
const workerRequests: string[] = [];
const pageErrors: string[] = [];
page.on("request", (request) => {
  if (["languageServerProcess.worker", "extensionHost.worker", "debugRuntimeProcess.worker"].some((name) => request.url().includes(name))) {
    workerRequests.push(request.url());
  }
});
page.on("pageerror", (error) => pageErrors.push(error.message));

try {
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.click("#welcome-start");
  try {
    await page.waitForFunction(
      () => document.querySelector("#editor-statusbar")?.textContent?.includes("LSP ready"),
      null,
      { timeout: 60_000 }
    );
  } catch {
    assert.fail(`LSP did not become ready: status=${await page.locator("#editor-statusbar").textContent()} errors=${JSON.stringify(pageErrors)}`);
  }

  const editor = page.locator(".monaco-editor").first();
  await editor.click({ position: { x: 240, y: 160 } });
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.insertText("\n// FIXME");
  await page.waitForFunction(
    () => document.querySelector("#editor-statusbar [aria-label]")?.getAttribute("aria-label") === "0 errors and 1 warnings",
    null,
    { timeout: 15_000 }
  );

  await page.getByRole("tab", { name: /^Problems/ }).click();
  await page.getByText("FIXME marker requires attention.").waitFor({ timeout: 15_000 });

  await page.getByRole("button", { name: "Run and Extensions" }).click();
  await page.getByText("Workspace Tools · active").waitFor({ timeout: 15_000 });
  await page.getByLabel("commands.register").uncheck();
  await page.getByText("grants: languages.diagnostics").waitFor({ timeout: 15_000 });
  assert.equal(await page.locator("#extension-run-command").isDisabled(), true);
  await page.getByRole("button", { name: "Explorer" }).click();
  await page.getByRole("button", { name: "Run and Extensions" }).click();
  await page.getByText("Workspace Tools · active").waitFor({ timeout: 15_000 });
  assert.equal(await page.getByLabel("commands.register").isChecked(), false);
  await page.getByLabel("commands.register").check();
  await page.getByText("grants: languages.diagnostics, commands.register").waitFor({ timeout: 15_000 });
  await page.locator("#extension-run-command").click();
  await page.getByText("Hello from isolated Workspace Tools").waitFor();
  await page.locator("#extension-crash-recover").click();
  await page.getByText("recoveries 1/1").waitFor({ timeout: 15_000 });

  await page.locator("#debug-start").click();
  await page.getByText("paused · breakpoint · line 3").waitFor({ timeout: 15_000 });
  assert.equal(await page.locator("#debug-stack").textContent(), "guestMain:3");
  assert.equal(await page.locator("#debug-scopes").textContent(), "Locals");
  assert.equal(await page.locator("#debug-variables").textContent(), "counter=2");
  await page.locator("#debug-step").click();
  await page.getByText("paused · step · line 4").waitFor({ timeout: 15_000 });
  await page.locator("#debug-continue").click();
  await page.getByText("paused · breakpoint · line 4").waitFor({ timeout: 15_000 });
  await page.locator("#debug-watch").click();
  await page.getByText("counter + 1=5").waitFor({ timeout: 15_000 });
  await page.locator("#debug-console-run").click();
  await page.getByText("counter=7").waitFor({ timeout: 15_000 });
  await page.locator("#debug-terminate").click();
  await page.getByText("terminated · breakpoint · line 4").waitFor({ timeout: 15_000 });

  for (const workerName of ["languageServerProcess.worker", "extensionHost.worker", "debugRuntimeProcess.worker"]) {
    assert.ok(workerRequests.some((url) => url.includes(workerName)), `${workerName} must be requested`);
  }
  assert.ok(workerRequests.every((url) => new URL(url).origin === baseUrl), "IDE protocol workers must remain same-origin");
  assert.deepEqual(pageErrors, []);
  console.log("preview-service browser IDE protocol vertical slices ok");
} finally {
  await browser.close();
  server.kill("SIGTERM");
}

function waitForServer() {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("preview-service Vite start timeout")), 60_000);
    const onData = (chunk: unknown) => {
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
