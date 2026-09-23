import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const appRoot = path.join(root, "apps/preview-service");
const chromePath = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const policy = JSON.parse(fs.readFileSync(path.join(root, "compat/runtime-reliability-policy.json"), "utf8"));
const iterations = Number.parseInt(
  process.env.WORKFLOW_SOAK_ITERATIONS || String(policy.soak.installDevRestartIterationsDefault || 25),
  10
);
assert.ok(Number.isSafeInteger(iterations) && iterations > 0, `invalid WORKFLOW_SOAK_ITERATIONS: ${iterations}`);
assert.ok(fs.existsSync(chromePath), `Chrome not found at ${chromePath}`);

const port = 5195;
const viteBin = path.join(appRoot, "node_modules/.bin/vite");
const server = spawn(viteBin, ["--host", "127.0.0.1", "--port", String(port), "--strictPort"], {
  cwd: appRoot,
  env: { ...process.env },
  stdio: ["ignore", "pipe", "pipe"]
});

await waitForServer(server, port);

const browser = await chromium.launch({
  executablePath: chromePath,
  headless: true
});
const page = await browser.newPage();

try {
  await page.goto(`http://127.0.0.1:${port}`, { waitUntil: "networkidle" });
  await page.waitForFunction(() => Boolean(globalThis.__previewService), null, { timeout: 30_000 });

  for (let i = 0; i < iterations; i += 1) {
    await page.evaluate(async () => {
      globalThis.__previewService.loadTemplate("vite-react");
      await globalThis.__previewService.runPreview();
      await globalThis.__previewService.restartDev();
      await globalThis.__previewService.runBuild();
    });

    const snapshot = await page.evaluate(() => globalThis.__previewService.snapshot());
    assert.ok(
      snapshot.phase === "built" || snapshot.phase === "preview_ready" || snapshot.phase === "hmr_connected",
      `unexpected phase at iteration ${i}: ${snapshot.phase}`
    );
    assert.ok(snapshot.previewUrl, `missing preview URL at iteration ${i}`);
  }

  console.log(`preview service workflow soak ok iterations=${iterations}`);
} finally {
  await browser.close();
  server.kill("SIGTERM");
}

function waitForServer(child, listenPort) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("preview-service vite start timeout")), 60_000);
    const onData = (chunk) => {
      const text = String(chunk);
      if (text.includes("Local:") || text.includes(`http://127.0.0.1:${listenPort}`)) {
        clearTimeout(timer);
        resolve();
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", (chunk) => {
      process.stderr.write(chunk);
      onData(chunk);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`preview-service vite exited early: ${code}`));
    });
  });
}
