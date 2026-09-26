import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const appRoot = path.join(root, "apps/preview-service");
const chromePath =
  process.env.CHROME_PATH ||
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const port = 5297;
const baseUrl = `http://127.0.0.1:${port}`;
const viteBin = path.join(appRoot, "node_modules/.bin/vite");
const server = spawn(
  viteBin,
  ["--host", "127.0.0.1", "--port", String(port), "--strictPort"],
  {
    cwd: appRoot,
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
  },
);

await waitForServer();
const browser = await chromium.launch({
  executablePath: chromePath,
  headless: true,
});
const page = await browser.newPage();

try {
  await page.route("**/src/components/CommandPalette.tsx*", (route) =>
    route.abort("failed"),
  );
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.waitForFunction(() => Boolean(globalThis.__previewService));
  await page.keyboard.press("F1");

  const recovery = page.locator('[data-lazy-feature-error="Command palette"]');
  await recovery.waitFor();
  assert.match(await recovery.textContent(), /Command palette failed to load/);
  await recovery.getByRole("button", { name: "Reload application" }).waitFor();

  await page.unroute("**/src/components/CommandPalette.tsx*");
  await recovery.getByRole("button", { name: "Reload application" }).click();
  await page.waitForFunction(() => Boolean(globalThis.__previewService));
  assert.equal(
    await page.locator('[data-lazy-feature-error="Command palette"]').count(),
    0,
  );

  await page.route("**/src/lib/formatDocument.ts*", (route) =>
    route.abort("failed"),
  );
  await page.evaluate(() => globalThis.__previewService.loadTemplate("vite-react"));
  await page.locator("#editor-format").click();
  const notificationsButton = page.getByRole("button", {
    name: "Notifications (1)",
  });
  await notificationsButton.waitFor();
  await notificationsButton.click();
  const notificationCenter = page.getByRole("region", {
    name: "Notification center",
  });
  await notificationCenter.getByText("Format unavailable").waitFor();
  await notificationCenter.getByText(/Reload the application and try again/).waitFor();

  console.log("preview-service lazy feature recovery ok");
} finally {
  await browser.close();
  server.kill("SIGTERM");
}

function waitForServer() {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("preview-service Vite start timeout")),
      60_000,
    );
    const onData = (chunk: Buffer) => {
      const text = String(chunk);
      if (
        text.includes("Local:") ||
        text.includes(`http://127.0.0.1:${port}`)
      ) {
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
