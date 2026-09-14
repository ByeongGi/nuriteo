import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";

const chromePath = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

if (!fs.existsSync(chromePath)) {
  throw new Error(`Chrome not found at ${chromePath}`);
}

async function withRuntimeLab(callback) {
  const server = spawn(process.execPath, [new URL("../../examples/runtime-lab/server.mjs", import.meta.url).pathname], {
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
  const processFailure = await page.evaluate(async () => {
    try {
      await globalThis.__runtimeLab.boot({ forceProcessFailure: true });
      return "unexpected success";
    } catch (error) {
      return { message: error.message, status: globalThis.__runtimeLab.status() };
    }
  });
  if (!processFailure.message.includes("Process worker failed")) {
    throw new Error(`missing process failure message: ${JSON.stringify(processFailure)}`);
  }
  if (processFailure.status !== "stopped") throw new Error(`runtime did not stop after process failure: ${processFailure.status}`);

  const systemFailure = await page.evaluate(async () => {
    try {
      await globalThis.__runtimeLab.boot({ forceSystemFailure: true });
      return "unexpected success";
    } catch (error) {
      return { message: error.message, status: globalThis.__runtimeLab.status() };
    }
  });
  if (!systemFailure.message.includes("System worker failed")) {
    throw new Error(`missing system failure message: ${JSON.stringify(systemFailure)}`);
  }
  if (systemFailure.status !== "stopped") throw new Error(`runtime did not stop after system failure: ${systemFailure.status}`);

  await page.evaluate(async () => {
    await globalThis.__runtimeLab.boot();
    await globalThis.__runtimeLab.teardown();
    await globalThis.__runtimeLab.teardown();
  });
  if (await page.locator("#status").textContent() !== "stopped") throw new Error("repeated teardown did not settle stopped status");
});

console.log("browser recovery test ok");
