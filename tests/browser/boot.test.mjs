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
  const result = await page.evaluate(() => globalThis.__runtimeLab.boot());
  if (result.role !== "system") throw new Error("runtime did not boot through system worker");
  if (!result.details.processSeen) throw new Error("system worker did not see process worker");
  if (result.details.syscall?.payload !== "pong") throw new Error("SAB syscall ping did not roundtrip");
  if (result.details.syscall?.generation !== 1) throw new Error("SAB syscall generation was not echoed");
  if (result.details.syscall?.pid !== 1) throw new Error("SAB syscall PID was not echoed from request header");
  if (await page.locator("#status").textContent() !== "ready") throw new Error("status was not ready");
  const fsResult = await page.evaluate(() => globalThis.__runtimeLab.runFsSmoke());
  if (fsResult.exports?.value !== "hello") throw new Error("node:fs binding did not read written file");
  if (fsResult.exports?.size !== 5) throw new Error("node:fs binding stat size mismatch");
  const previewResult = await page.evaluate(() => globalThis.__runtimeLab.runPreviewSmoke());
  if (previewResult.ready.type !== "preview:ready") throw new Error("preview handshake did not complete");
  if (previewResult.routed.response?.body !== "preview:/index.html") throw new Error("preview request did not route to container port");
  if (!previewResult.hmr.includes("message:update")) throw new Error("HMR reconnect/update smoke did not complete");
  const terminalResult = await page.evaluate(async () => {
    const install = await globalThis.__runtimeLab.runTerminalCommand("npm install");
    const pending = globalThis.__runtimeLab.runTerminalCommand("sleep");
    const active = globalThis.__runtimeLab.terminalTranscript().at(-1);
    const cancelAccepted = globalThis.__runtimeLab.cancelTerminalCommand();
    const cancelled = await pending;
    globalThis.__runtimeLab.restartTerminal();
    const build = await globalThis.__runtimeLab.runTerminalCommand("vite build");
    return {
      install,
      active,
      cancelAccepted,
      cancelled,
      build,
      history: globalThis.__runtimeLab.terminalHistory(),
      output: globalThis.__runtimeLab.terminalOutput()
    };
  });
  if (terminalResult.install.entry.status !== "completed") throw new Error("terminal install did not complete");
  if (!terminalResult.install.stdout.includes("linked node_modules/.bin/vite")) {
    throw new Error("terminal install did not show linked Vite bin");
  }
  if (terminalResult.active.command !== "sleep") throw new Error("terminal did not expose active command");
  if (!terminalResult.cancelAccepted) throw new Error("terminal cancel was not accepted");
  if (terminalResult.cancelled.entry.status !== "cancelled") throw new Error("terminal command was not cancelled");
  if (terminalResult.build.stdout !== "vite build completed\n") throw new Error("terminal build did not run after restart");
  if (!terminalResult.history.includes("vite build")) throw new Error("terminal history did not include build command");
  if (!terminalResult.output.includes("$ npm install")) throw new Error("terminal output did not include command prompt");
  await page.evaluate(() => globalThis.__runtimeLab.teardown());
  if (await page.locator("#status").textContent() !== "stopped") throw new Error("status was not stopped");
});

await withRuntimeLab(async (page, baseUrl) => {
  await page.goto(`${baseUrl}/broken/`, { waitUntil: "load" });
  const status = await page.locator("#status").textContent();
  if (status !== "isolation-missing") throw new Error(`expected isolation diagnostic, got ${status}`);
  const error = await page.evaluate(async () => {
    try {
      await globalThis.__runtimeLab.boot();
      return "unexpected success";
    } catch (cause) {
      return cause.message;
    }
  });
  if (!error.includes("requires COOP/COEP isolation")) {
    throw new Error(`missing isolation error, got ${error}`);
  }
});

console.log("browser boot test ok");
