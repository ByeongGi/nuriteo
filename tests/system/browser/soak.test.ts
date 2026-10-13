import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";

const chromePath = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

if (!fs.existsSync(chromePath)) {
  throw new Error(`Chrome not found at ${chromePath}`);
}

async function withRuntimeLab(callback) {
  const server = spawn(process.execPath, [new URL("../../fixtures/runtime-lab/server.ts", import.meta.url).pathname], {
    env: {
      ...process.env,
      PORT: "0"
    },
    stdio: ["ignore", "pipe", "inherit"]
  });
  const [line] = await once(server.stdout, "data");
  const match = String(line).match(/http:\/\/127\.0\.0\.1:\d+/);
  if (!match) throw new Error(`could not parse runtime-lab URL from ${line}`);
  const browser = await chromium.launch({
    headless: true,
    executablePath: chromePath
  });
  try {
    const page = await browser.newPage();
    return await callback(page, match[0]);
  } finally {
    await browser.close();
    server.kill("SIGTERM");
  }
}

await withRuntimeLab(async (page, baseUrl) => {
  await page.goto(baseUrl, { waitUntil: "load" });
  await page.waitForFunction(() => Boolean(globalThis.__runtimeLab?.boot), null, { timeout: 5000 });
  const iterations = Number.parseInt(process.env.SOAK_ITERATIONS || "100", 10);
  if (!Number.isSafeInteger(iterations) || iterations <= 0) throw new Error(`invalid SOAK_ITERATIONS: ${process.env.SOAK_ITERATIONS}`);
  for (let i = 0; i < iterations; i += 1) {
    const metrics = await page.evaluate(async () => {
      await globalThis.__runtimeLab.boot();
      await globalThis.__runtimeLab.runFsSmoke();
      const beforeTeardown = globalThis.__runtimeLab.metrics();
      const system = await globalThis.__runtimeLab.systemMetrics();
      await globalThis.__runtimeLab.teardown();
      return { beforeTeardown, system, status: globalThis.__runtimeLab.status() };
    });
    if (metrics.beforeTeardown.activeWorkers !== 2) throw new Error(`active workers did not reach run budget at iteration ${i}`);
    if (metrics.beforeTeardown.pendingRequests !== 0) throw new Error(`pending requests leaked before teardown at iteration ${i}`);
    if (metrics.system.openFiles !== 0) throw new Error(`open file descriptors leaked at iteration ${i}`);
    if (metrics.system.watchCount !== 0) throw new Error(`watch handles leaked at iteration ${i}`);
    if (metrics.system.portCount !== 0) throw new Error(`ports leaked at iteration ${i}`);
    if (metrics.system.pendingRequests !== 0) throw new Error(`system requests leaked at iteration ${i}`);
    if (metrics.status !== "stopped") throw new Error(`runtime not stopped at iteration ${i}`);
  }
});

console.log("browser soak test ok");
