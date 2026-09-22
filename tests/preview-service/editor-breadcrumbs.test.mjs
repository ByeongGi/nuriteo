import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const appRoot = path.join(root, "apps/preview-service");
const chromePath = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const port = 5190;
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

  const selectedPath = await page.evaluate(() => {
    const api = globalThis.__previewService;
    api.loadTemplate("vite-react");
    const path = api.snapshot().project.listFiles().find((file) => file.path.endsWith("src/App.tsx"))?.path;
    if (!path) throw new Error("vite-react template must include src/App.tsx");
    api.openFile(path);
    return path;
  });

  const breadcrumbs = page.getByRole("navigation", { name: "Editor breadcrumbs" });
  await breadcrumbs.getByText("App.tsx", { exact: true }).waitFor();
  assert.equal(await breadcrumbs.getByRole("list").getAttribute("aria-label"), "src/App.tsx");
  assert.deepEqual(await breadcrumbs.getByRole("listitem").allTextContents(), ["src", "/App.tsx"]);
  assert.equal(await breadcrumbs.locator('[aria-current="page"]').textContent(), "App.tsx");
  assert.equal(await breadcrumbs.getAttribute("title"), "src/App.tsx");
  assert.equal(await page.locator("#editor-path").textContent(), "src/App.tsx");
  assert.ok(selectedPath.startsWith("/workspace/"), "test must verify workspace prefix is removed");

  const overflow = await breadcrumbs.evaluate((element) => {
    element.style.width = "40px";
    element.style.flex = "none";
    return {
      overflowX: getComputedStyle(element).overflowX,
      hasOverflow: element.scrollWidth > element.clientWidth
    };
  });
  assert.equal(overflow.overflowX, "auto");
  assert.equal(overflow.hasOverflow, true);

  console.log("preview service editor breadcrumbs ok");
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
