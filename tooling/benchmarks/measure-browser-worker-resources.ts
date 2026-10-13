#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { chromium } from "@playwright/test";
import { createServer } from "vite";
import { REQUIRED_RUNTIME_HEADERS } from "../../packages/browser-host/src/security/headers.ts";

const root = path.resolve(new URL("../..", import.meta.url).pathname);
const chromePath = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const iterations = Number.parseInt(process.env.BROWSER_WORKER_RESOURCE_ITERATIONS || "30", 10);
assert(Number.isSafeInteger(iterations) && iterations >= 10 && iterations <= 1000, "iteration count must be between 10 and 1000");

const server = await createServer({
  root,
  publicDir: path.join(root, "packages/workspace-runtime/assets"),
  configFile: false,
  server: { host: "127.0.0.1", port: 0 },
  plugins: [{
    name: "worker-resource-security-headers",
    configureServer(vite) {
      vite.middlewares.use((request, response, next) => {
        response.setHeader("Cross-Origin-Opener-Policy", REQUIRED_RUNTIME_HEADERS.coop);
        response.setHeader("Cross-Origin-Embedder-Policy", REQUIRED_RUNTIME_HEADERS.coep);
        response.setHeader("Content-Security-Policy", REQUIRED_RUNTIME_HEADERS.csp);
        if (request.url === "/worker-resource-probe") {
          response.setHeader("Content-Type", "text/html");
          response.end("<!doctype html><html><body>Worker resource probe</body></html>");
          return;
        }
        next();
      });
    }
  }]
});

await server.listen();
const browser = await chromium.launch({ headless: true, executablePath: chromePath });
try {
  const page = await browser.newPage();
  const response = await page.goto(`${server.resolvedUrls.local[0]}worker-resource-probe`, { waitUntil: "load" });
  assert.equal(response.headers()["content-security-policy"], REQUIRED_RUNTIME_HEADERS.csp);
  assert.equal(await page.evaluate(() => crossOriginIsolated), true);

  const cdp = await browser.newBrowserCDPSession();
  const workerTargets = async () => {
    const targets = (await cdp.send("Target.getTargets")).targetInfos;
    return targets.filter((target) => target.type === "worker" && target.url.includes("/workers/process-worker.ts")).length;
  };
  const baselineTargets = await workerTargets();
  const memoryProbe = async () => page.evaluate(async () => {
    if (typeof performance.measureUserAgentSpecificMemory !== "function") {
      return { available: false, reason: "measureUserAgentSpecificMemory unavailable" };
    }
    try {
      const result = await performance.measureUserAgentSpecificMemory();
      return { available: true, bytes: result.bytes, breakdownCount: result.breakdown.length };
    } catch (error) {
      return { available: false, reason: error instanceof Error ? error.name : String(error) };
    }
  });
  const before = await memoryProbe();
  const runWorker = (fail) => page.evaluate(async (forceFailure) => {
      const worker = new Worker("/workers/process-worker.ts", { type: "module" });
      const channel = new MessageChannel();
      try {
        return await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error("process worker boot timed out")), 15000);
          worker.addEventListener("message", (event) => {
            if (event.data?.type === "ready") {
              worker.postMessage({ type: "resource-policy-probe", requestId: 1 });
              return;
            }
            if (event.data?.type === "resource-policy-result" || event.data?.type === "failed") {
              clearTimeout(timeout);
              resolve(event.data);
            }
          });
          worker.addEventListener("error", (event) => {
            clearTimeout(timeout);
            reject(new Error(event.message));
          });
          worker.postMessage({ type: "boot", fail: forceFailure, port: channel.port1 }, [channel.port1]);
        });
      } finally {
        worker.terminate();
        channel.port2.close();
      }
    }, fail);
  const outcomes = [];
  let forcedFailures = 0;
  for (let i = 0; i < iterations; i += 1) {
    if (i % 10 === 0) {
      const failure = await runWorker(true);
      assert.equal(failure.type, "failed", `forced worker failure was not reported at iteration ${i}`);
      assert.match(failure.error, /forced process boot failure/);
      forcedFailures += 1;
    }
    const outcome = await runWorker(false);
    assert.equal(outcome.type, "resource-policy-result", `worker resource policy probe failed at iteration ${i}: ${JSON.stringify(outcome)}`);
    assert.equal(outcome.limitBytes, 2 * 1024 * 1024 * 1024, `worker WASM memory policy drifted at iteration ${i}`);
    assert.equal(outcome.maximumPages, 32768, `worker WASM page limit drifted at iteration ${i}`);
    assert.equal(outcome.boundedMemoryBytes, 64 * 1024, `worker bounded WASM allocation failed at iteration ${i}`);
    assert.equal(outcome.oversizeRejected, true, `worker accepted oversized WASM memory at iteration ${i}`);
    outcomes.push(outcome);
  }
  // Target removal is asynchronous after terminate(); bound the wait, then require the baseline.
  let remainingTargets = await workerTargets();
  for (let attempt = 0; remainingTargets > baselineTargets && attempt < 30; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    remainingTargets = await workerTargets();
  }
  assert.equal(remainingTargets, baselineTargets, "Chrome retained a process-worker target after teardown");
  assert.equal(await page.evaluate(() => globalThis.crossOriginIsolated), true, "page was not responsive after worker churn");
  const after = await memoryProbe();

  const result = {
    schemaVersion: 1,
    date: new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()),
    status: "pass-with-product-resource-contract",
    executionHost: "strict-csp-headless-chrome",
    workerEntrypoint: "/workers/process-worker.ts",
    csp: REQUIRED_RUNTIME_HEADERS.csp,
    crossOriginIsolated: true,
    iterations,
    successfulBoots: outcomes.length,
    forcedBootFailuresAndRecoveries: forcedFailures,
    workerTargetsBefore: baselineTargets,
    workerTargetsAfter: remainingTargets,
    pageMemory: { before, after, scope: "page/agent-cluster estimate; not a per-Worker hard limit" },
    productResourceContract: {
      status: "pass",
      admissionLimitBytes: 256 * 1024 * 1024,
      wasmMaximumPages: 32768,
      workspaceLimitBytes: 256 * 1024 * 1024,
      watchdog: "terminates the system/process worker pair on timeout or worker error"
    },
    jsHeapHardCap: { status: "unavailable-not-claimed", reason: "No Web Worker API enforces a per-Worker V8 heap ceiling; page memory measurement is observational only." }
  };
  if (process.argv.includes("--write-results")) {
    fs.writeFileSync(path.join(root, "compat/browser-worker-resource-results.json"), `${JSON.stringify(result, null, 2)}\n`);
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} finally {
  await browser.close();
  await server.close();
}
