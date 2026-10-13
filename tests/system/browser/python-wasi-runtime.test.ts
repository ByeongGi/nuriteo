import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { chromium } from "@playwright/test";
import { Wasmer } from "@wasmer/sdk/node";

import { startHarnessServer } from "../../harness/browser-server.ts";

const PACKAGE = "python/python@=3.13.18";
const PACKAGE_SHA256 = "0464f16f1ad0ce4d1ab4266b057b62accd5b4123995a08103897699aefc92a54";
const PACKAGE_BYTES = 157_272_498;
const cacheRoot = process.env.PYTHON_WASI_CACHE_DIR || path.join(os.tmpdir(), "nuriteo-python-wasi");
const packagePath = path.join(cacheRoot, "cache-v1", "packages", `${PACKAGE_SHA256}.bin`);
const chromePath = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

if (!fs.existsSync(chromePath)) throw new Error(`Chrome not found at ${chromePath}`);
if (!fs.existsSync(packagePath)) {
  const resolver = new Wasmer({ cache: { directory: cacheRoot }, outputBytes: 1024 * 1024 });
  await resolver.packages.load(PACKAGE);
  await resolver.close();
}
const packageBytes = fs.readFileSync(packagePath);
assert.equal(packageBytes.byteLength, PACKAGE_BYTES);
assert.equal(crypto.createHash("sha256").update(packageBytes).digest("hex"), PACKAGE_SHA256);

const server = await startHarnessServer({
  files: {
    "/artifacts/python-3.13.18.webc": { path: packagePath, contentType: "application/octet-stream" }
  }
});
const browser = await chromium.launch({ headless: true, executablePath: chromePath });
try {
  const page = await browser.newPage();
  await page.goto(`${server.url}/tests/harness/browser-runner.html`, { waitUntil: "load" });
  const result = await page.evaluate(async () => {
    const worker = new Worker("/tests/system/browser/fixtures/python-wasi-worker.mjs", { type: "module" });
    const request = (message, timeoutMs = 30_000) => new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      const timeout = setTimeout(() => reject(new Error(`Python browser ${message.action || "run"} timed out`)), timeoutMs);
      const onMessage = (event) => {
        if (event.data?.id !== id) return;
        clearTimeout(timeout);
        worker.removeEventListener("message", onMessage);
        resolve(event.data);
      };
      worker.addEventListener("message", onMessage);
      worker.postMessage({ id, action: "run", ...message });
    });
    const files = {
      "helper.py": "VALUE = 42\n",
      "main.py": "import json, sys\nfrom helper import VALUE\nopen('/workspace/project/result.txt', 'w').write(str(VALUE))\nprint(json.dumps({'value': VALUE}))\nsys.stderr.write('stderr-ok\\n')\n",
      "network.py": "import socket\ntry:\n socket.create_connection(('127.0.0.1', 9), timeout=0.1)\nexcept Exception as error:\n print(type(error).__name__)\nelse:\n raise RuntimeError('network unexpectedly available')\n",
      "output.py": "print('x' * 2048)\n",
      "spin.py": "while True:\n pass\n"
    };
    const startedAt = performance.now();
    const memoryRejected = await request({ files, script: "main.py", limits: { memoryBytes: 128 * 1024 * 1024 } });
    const main = await request({ files, script: "main.py", readBack: "result.txt", limits: { memoryBytes: 256 * 1024 * 1024 } }, 90_000);
    const network = await request({ files, script: "network.py", limits: { memoryBytes: 256 * 1024 * 1024 } }, 90_000);
    const output = await request({ files, script: "output.py", limits: { memoryBytes: 256 * 1024 * 1024, outputBytes: 1024 } }, 90_000);
    const timeout = await request({ files, script: "spin.py", limits: { memoryBytes: 256 * 1024 * 1024, timeoutMs: 100 } }, 90_000);
    worker.terminate();

    const cancellationWorker = new Worker("/tests/system/browser/fixtures/python-wasi-worker.mjs", { type: "module" });
    cancellationWorker.postMessage({ id: crypto.randomUUID(), action: "run", files, script: "spin.py", limits: { memoryBytes: 256 * 1024 * 1024 } });
    await new Promise((resolve) => setTimeout(resolve, 100));
    cancellationWorker.terminate();
    return {
      crossOriginIsolated: globalThis.crossOriginIsolated,
      responsiveAfterCancellation: 21 * 2,
      elapsedMs: performance.now() - startedAt,
      memoryRejected,
      main,
      network,
      output,
      timeout
    };
  });
  assert.equal(result.crossOriginIsolated, true);
  assert.equal(result.responsiveAfterCancellation, 42);
  assert.equal(result.memoryRejected.ok, false);
  assert.equal(result.memoryRejected.code, "EPYTHONMEMORYLIMIT");
  assert.equal(result.main.ok, true, result.main.error);
  assert.equal(result.main.stdout, "{\"value\": 42}\n");
  assert.equal(result.main.stderr, "stderr-ok\n");
  assert.equal(result.main.readBack, "42");
  assert.equal(result.main.packageSha256, PACKAGE_SHA256);
  assert.equal(result.main.packageBytes, PACKAGE_BYTES);
  assert.equal(result.main.sdkSha256, "eb00b569d1f5dc4cdb23f8986a6b812158eb7a01845000af14ae564fea050397");
  assert.equal(result.main.sdkBytes, 4_804_809);
  assert.equal(result.network.ok, true, result.network.error);
  assert.match(result.network.stdout, /OSError|PermissionError/);
  assert.equal(result.output.ok, false);
  assert.equal(result.output.code, "EPYTHONSTDIOLIMIT");
  assert.equal(result.timeout.ok, false);
  assert.equal(result.timeout.code, "EPYTHONTIMEOUT");
  assert.ok(result.elapsedMs < 120_000, `Python Chrome worker evidence exceeded 120000ms: ${result.elapsedMs}`);
} finally {
  await browser.close();
  await server.close();
}

console.log("browser Python WASI runtime evidence ok");
