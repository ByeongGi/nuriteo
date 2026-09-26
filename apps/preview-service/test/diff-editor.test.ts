import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const appRoot = path.join(root, "apps/preview-service");
const chromePath = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const port = 5293;
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
  await page.addInitScript(() => {
    localStorage.setItem("cargo.preview-service.settings", JSON.stringify({ saveTrigger: "manual" }));
  });
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.waitForFunction(() => Boolean(globalThis.__previewService));
  await page.evaluate(() => {
    const api = globalThis.__previewService;
    const snapshot = api.loadTemplate("vite-react");
    const path = snapshot.project.listFiles().find((file) => file.path.endsWith("src/App.tsx"))?.path;
    if (!path) throw new Error("Expected src/App.tsx");
    api.openFile(path);
    api.editCurrentFile("export default function App() { return <main>Changed</main>; }\n");
  });

  await page.getByRole("button", { name: "Source Control" }).click();
  const sourceControl = page.getByRole("complementary", { name: "Source control" });
  await sourceControl.waitFor();
  await sourceControl.getByRole("button", { name: "Open diff" }).click();

  const diffEditor = page.getByRole("region", { name: "Diff editor" });
  await diffEditor.waitFor();
  const split = diffEditor.getByRole("button", { name: "Split" });
  const unified = diffEditor.getByRole("button", { name: "Unified" });
  assert.equal(await split.getAttribute("aria-pressed"), "true");
  assert.equal(await unified.getAttribute("aria-pressed"), "false");

  await unified.click();
  assert.equal(await unified.getAttribute("aria-pressed"), "true");
  assert.equal(await split.getAttribute("aria-pressed"), "false");

  await diffEditor.getByText(/\d+ changes?/).waitFor();
  assert.equal(await diffEditor.getByRole("button", { name: "Next change" }).isEnabled(), true);
  assert.equal(await diffEditor.getByRole("button", { name: "Previous change" }).isEnabled(), true);

  console.log("preview service diff editor accessibility ok");
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
