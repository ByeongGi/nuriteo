import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import path, { dirname } from "node:path";

import { chromium } from "@playwright/test";
import { createServer } from "../node_modules/vite/dist/node/index.js";

import { REQUIRED_RUNTIME_HEADERS } from "../../../packages/browser-host/src/security/headers.ts";

const require = createRequire(import.meta.url);
const root = path.resolve(new URL("../../..", import.meta.url).pathname);
const nextRoot = dirname(realpathSync(require.resolve("next/package.json")));
const nextManifest = JSON.parse(fs.readFileSync(path.join(nextRoot, "package.json"), "utf8"));
const nextEntry = fs.readFileSync(path.join(nextRoot, "dist/bin/next"));
const nextRequireHook = fs.readFileSync(path.join(nextRoot, "dist/server/require-hook.js"));
const nextEntrySha256 = createHash("sha256").update(nextEntry).digest("hex");
const chromePath = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

assert.equal(nextManifest.version, "15.1.9");
assert.equal(typeof nextManifest.bin === "string" ? nextManifest.bin : nextManifest.bin?.next, "./dist/bin/next");
assert.ok(fs.existsSync(chromePath), `Chrome not found at ${chromePath}`);

const encode = (value: Buffer | string) => Buffer.from(value).toString("base64");
const workspaceSnapshot = {
  directories: [
    "/",
    "/workspace",
    "/workspace/app",
    "/workspace/app/node_modules",
    "/workspace/app/node_modules/next",
    "/workspace/app/node_modules/next/dist",
    "/workspace/app/node_modules/next/dist/bin",
    "/workspace/app/node_modules/next/dist/server"
  ],
  files: [
    {
      path: "/workspace/app/package.json",
      data: encode(JSON.stringify({
        name: "next-browser-worker-preflight",
        private: true,
        scripts: { build: "next build", dev: "next dev", start: "next start" },
        dependencies: { next: "15.1.9", react: "19.0.0", "react-dom": "19.0.0" }
      })),
      encoding: "base64"
    },
    {
      path: "/workspace/app/node_modules/next/package.json",
      data: encode(JSON.stringify(nextManifest)),
      encoding: "base64"
    },
    {
      path: "/workspace/app/node_modules/next/dist/bin/next",
      data: encode(nextEntry),
      encoding: "base64"
    },
    {
      path: "/workspace/app/node_modules/next/dist/server/require-hook.js",
      data: encode(nextRequireHook),
      encoding: "base64"
    }
  ],
  links: []
};
let tamperFactoryResponse = false;

const server = await createServer({
  root,
  publicDir: path.join(root, "apps/preview-service/public"),
  configFile: false,
  server: { host: "127.0.0.1", port: 0 },
  plugins: [{
    name: "next-browser-worker-security-headers",
    configureServer(vite) {
      vite.middlewares.use((request, response, next) => {
        response.setHeader("Cross-Origin-Opener-Policy", REQUIRED_RUNTIME_HEADERS.coop);
        response.setHeader("Cross-Origin-Embedder-Policy", REQUIRED_RUNTIME_HEADERS.coep);
        response.setHeader("Content-Security-Policy", REQUIRED_RUNTIME_HEADERS.csp);
        if (request.url === "/vendor/next-cli-15.1.9.mjs" && tamperFactoryResponse) {
          response.setHeader("Content-Type", "text/javascript; charset=utf-8");
          response.end("export const sourceSha256 = 'tampered'; export function evaluateNextCjs() {}\n");
          return;
        }
        if (request.url === "/next-browser-worker-probe") {
          response.setHeader("Content-Type", "text/html; charset=utf-8");
          response.end("<!doctype html><html><body>Next browser worker probe</body></html>");
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
  const response = await page.goto(`${server.resolvedUrls.local[0]}next-browser-worker-probe`, { waitUntil: "load" });
  assert.equal(response?.headers()["content-security-policy"], REQUIRED_RUNTIME_HEADERS.csp);
  assert.equal(await page.evaluate(() => crossOriginIsolated), true);

  const cdp = await browser.newBrowserCDPSession();
  const workerTargetCount = async () => {
    const targets = (await cdp.send("Target.getTargets")).targetInfos;
    return targets.filter((target) => target.type === "worker" && target.url.includes("/workers/process-worker.ts")).length;
  };
  const baselineTargets = await workerTargetCount();
  const assertWorkersReleased = async (label: string) => {
    let remainingTargets = await workerTargetCount();
    for (let attempt = 0; remainingTargets > baselineTargets && attempt < 30; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      remainingTargets = await workerTargetCount();
    }
    assert.equal(remainingTargets, baselineTargets, `Chrome retained a Next preflight worker after ${label}`);
  };

  const runPreflight = (id: number, command: "dev" | "build" | "start") => page.evaluate(async ({ command, entrySha256, id, snapshot }) => {
    const worker = new Worker("/workers/process-worker.ts", { type: "module" });
    try {
      return await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`Next ${command} worker preflight timed out`)), 30_000);
        worker.addEventListener("message", (event) => {
          if (event.data?.type !== "cli:result" || event.data.id !== id) return;
          clearTimeout(timeout);
          resolve(event.data);
        });
        worker.addEventListener("error", (event) => {
          clearTimeout(timeout);
          reject(new Error(event.message));
        });
        worker.postMessage({
          id,
          type: "cli:evaluate",
          root: "/workspace",
          request: {
            entry: {
              name: "next",
              version: "15.1.9",
              entry: "/workspace/app/node_modules/next/dist/bin/next",
              entrySha256,
              mode: "cjs"
            },
            args: [command],
            cwd: "/workspace/app",
            env: { PORT: "3045" }
          },
          workspaceSnapshot: snapshot
        });
      });
    } finally {
      worker.terminate();
    }
  }, { command, entrySha256: nextEntrySha256, id, snapshot: workspaceSnapshot });

  for (const [index, command] of (["dev", "build", "start"] as const).entries()) {
    const outcome = await runPreflight(index + 1, command) as {
      error?: string;
      result?: { entrySha256?: string; exitCode?: number; stderr?: string };
    };
    assert.equal(outcome.error, undefined, `${command} worker transport failed: ${outcome.error}`);
    assert.equal(outcome.result?.entrySha256, nextEntrySha256);
    assert.equal(outcome.result?.exitCode, 1);
    assert.match(outcome.result?.stderr || "", /ECLICSPUNSUPPORTED/);
    assert.doesNotMatch(outcome.result?.stderr || "", /ECLICSPUNSUPPORTED:.*node_modules\/next\/dist\/bin\/next/);
    assert.match(outcome.result?.stderr || "", /node_modules\/next\/dist\/server\/require-hook\.js/);
  }

  await assertWorkersReleased("command teardown");

  tamperFactoryResponse = true;
  const rejectedFactory = await runPreflight(4, "dev") as { error?: string };
  assert.equal(rejectedFactory.error, "ERR_NEXT_CSP_FACTORY_INTEGRITY");
  tamperFactoryResponse = false;
  await assertWorkersReleased("factory integrity rejection");

  const recovery = await runPreflight(5, "dev") as { result?: { exitCode?: number; stderr?: string } };
  assert.equal(recovery.result?.exitCode, 1);
  assert.match(recovery.result?.stderr || "", /ECLICSPUNSUPPORTED/);
  await assertWorkersReleased("recovery teardown");
  assert.equal(await page.evaluate(() => crossOriginIsolated), true, "page did not recover after worker teardown/restart");
} finally {
  await browser.close();
  await server.close();
}

console.log(`next browser-worker preflight hold reproduced entrySha256=${nextEntrySha256}`);
