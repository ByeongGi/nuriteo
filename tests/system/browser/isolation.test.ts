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
  const result = await page.evaluate(async () => {
    const observed = {};

    observed.crossOriginIsolated = globalThis.crossOriginIsolated;
    observed.dynamicImportSelf = Boolean(await import("/packages/preview/src/index.ts"));

    try {
      new Function("return 1")();
      observed.codeGeneration = "allowed";
    } catch (error) {
      observed.codeGeneration = error.name;
    }

    observed.sameOriginFetch = await fetch("/packages/preview/src/index.ts").then((response) => response.ok);
    observed.crossOriginFetch = await fetch("http://127.0.0.1:1/blocked")
      .then(() => "allowed")
      .catch((error) => error.name);

    observed.sameOriginWorker = await new Promise((resolve) => {
      const worker = new Worker("/workers/process-worker.ts", { type: "module" });
      worker.addEventListener("error", () => resolve("error"), { once: true });
      setTimeout(() => {
        worker.terminate();
        resolve("created");
      }, 0);
    });

    observed.blobWorker = await new Promise((resolve) => {
      const url = URL.createObjectURL(new Blob(["postMessage('x')"], { type: "text/javascript" }));
      try {
        const worker = new Worker(url, { type: "module" });
        worker.addEventListener("error", () => resolve("blocked"), { once: true });
        setTimeout(() => {
          worker.terminate();
          URL.revokeObjectURL(url);
          resolve("created");
        }, 25);
      } catch (error) {
        URL.revokeObjectURL(url);
        resolve(error.name);
      }
    });

    observed.storageKeys = {
      local: Object.keys(localStorage),
      session: Object.keys(sessionStorage),
      cookie: document.cookie
    };

    const { createPreviewRelay, createPreviewSessionRegistry } = await import("/packages/preview/src/index.ts");
    const sessions = createPreviewSessionRegistry();
    const session = sessions.create({
      origin: location.origin,
      projectId: "project-a",
      port: 4173,
      container: { fetch: async () => ({ statusCode: 200, body: "ok" }) }
    });
    const relay = createPreviewRelay({ sessions });
    observed.previewForgery = await relay.request({
      sessionId: session.sessionId,
      origin: "https://evil.example",
      projectId: "project-a"
    }).then(() => "allowed").catch((error) => error.code);

    return observed;
  });

  if (!result.crossOriginIsolated) throw new Error("runtime route is not cross-origin isolated");
  if (result.dynamicImportSelf !== true) throw new Error("same-origin module import was not allowed");
  if (result.codeGeneration !== "EvalError") throw new Error(`code generation was not blocked: ${result.codeGeneration}`);
  if (result.sameOriginFetch !== true) throw new Error("same-origin fetch was not allowed");
  if (result.crossOriginFetch !== "TypeError") throw new Error(`cross-origin fetch was not blocked: ${result.crossOriginFetch}`);
  if (result.sameOriginWorker !== "created") throw new Error(`same-origin worker was not allowed: ${result.sameOriginWorker}`);
  if (result.blobWorker === "created") throw new Error("blob worker was allowed despite worker-src self");
  if (result.storageKeys.local.length || result.storageKeys.session.length || result.storageKeys.cookie) {
    throw new Error(`runtime origin stored product secrets: ${JSON.stringify(result.storageKeys)}`);
  }
  if (result.previewForgery !== "ESTALESESSION") throw new Error(`preview forgery was not rejected: ${result.previewForgery}`);
});

console.log("browser isolation test ok");
