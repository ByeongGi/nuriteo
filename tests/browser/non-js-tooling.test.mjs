import assert from "node:assert/strict";
import fs from "node:fs";

import { chromium } from "@playwright/test";

import { startHarnessServer } from "../harness/browser-server.mjs";

const chromePath = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
if (!fs.existsSync(chromePath)) throw new Error(`Chrome not found at ${chromePath}`);

const server = await startHarnessServer();
const browser = await chromium.launch({ headless: true, executablePath: chromePath });
try {
  const page = await browser.newPage();
  await page.goto(`${server.url}/tests/harness/browser-runner.html`, { waitUntil: "load" });
  const result = await page.evaluate(async () => {
    async function runWorker(message) {
      const worker = new Worker("/tests/browser/fixtures/sqlite-opfs-worker.mjs", { type: "module" });
      try {
        return await new Promise((resolve, reject) => {
          const id = crypto.randomUUID();
          const timeout = setTimeout(() => reject(new Error(`SQLite OPFS ${message.action} timed out`)), 10_000);
          worker.addEventListener("message", (event) => {
            if (event.data?.id !== id) return;
            clearTimeout(timeout);
            resolve(event.data);
          });
          worker.addEventListener("error", (event) => {
            clearTimeout(timeout);
            reject(new Error(event.message));
          }, { once: true });
          worker.postMessage({ id, ...message });
        });
      } finally {
        worker.terminate();
      }
    }

    const startedAt = performance.now();
    const write = await runWorker({ action: "replace-values", projectId: "project-a", database: "app", values: ["committed-a"] });
    const otherWrite = await runWorker({ action: "replace-values", projectId: "project-b", database: "app", values: ["committed-b"] });
    const reopened = await runWorker({ action: "read-values", projectId: "project-a", database: "app" });
    const otherReopened = await runWorker({ action: "read-values", projectId: "project-b", database: "app" });
    return {
      crossOriginIsolated: globalThis.crossOriginIsolated,
      elapsedMs: performance.now() - startedAt,
      write,
      reopened,
      otherWrite,
      otherReopened
    };
  });

  assert.equal(result.crossOriginIsolated, true);
  assert.equal(result.write.ok, true, result.write.error);
  assert.equal(result.reopened.ok, true, result.reopened.error);
  assert.equal(result.otherWrite.ok, true, result.otherWrite.error);
  assert.equal(result.otherReopened.ok, true, result.otherReopened.error);
  assert.deepEqual(result.write.rows, ["committed-a"]);
  assert.deepEqual(result.reopened.rows, ["committed-a"]);
  assert.deepEqual(result.otherReopened.rows, ["committed-b"]);
  assert.notEqual(result.reopened.databasePath, result.otherReopened.databasePath);
  assert.match(result.reopened.sqliteVersion, /^3\./);
  assert.ok(result.elapsedMs <= 10_000, `SQLite OPFS durability fixture exceeded 10000ms: ${result.elapsedMs}`);
} finally {
  await browser.close();
  await server.close();
}

console.log("browser non-JS tooling test ok");
