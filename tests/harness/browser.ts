import { chromium } from "@playwright/test";
import { startHarnessServer } from "./browser-server.ts";

const chromePath = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

export async function runBrowserWorker(source, options = {}) {
  const server = await startHarnessServer();
  const browser = await chromium.launch({
    headless: true,
    executablePath: chromePath
  });
  try {
    const page = await browser.newPage();
    await page.goto(`${server.url}/tests/harness/browser-runner.html`, {
      waitUntil: "load"
    });
    return await page.evaluate(
      (payload) => globalThis.__runHarnessWorker(payload),
      {
          source,
          assertFiles: options.assertFiles || []
      }
    );
  } finally {
    await browser.close();
    await server.close();
  }
}
