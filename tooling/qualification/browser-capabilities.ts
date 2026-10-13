import assert from "node:assert/strict";
import http from "node:http";

import { chromium } from "@playwright/test";

const executablePath = process.env.NURITEO_BROWSER_EXECUTABLE;
const expectedProduct = process.env.NURITEO_BROWSER_PRODUCT;
assert.ok(executablePath, "NURITEO_BROWSER_EXECUTABLE is required");
assert.ok(expectedProduct, "NURITEO_BROWSER_PRODUCT is required");

const server = http.createServer((request, response) => {
  response.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  if (request.url === "/sw.js") {
    response.setHeader("Content-Type", "text/javascript; charset=utf-8");
    response.setHeader("Service-Worker-Allowed", "/");
    response.end("self.addEventListener('install',()=>self.skipWaiting());self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));");
    return;
  }
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.end("<!doctype html><meta charset=utf-8><title>NURITEO browser qualification</title>");
});

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert.ok(address && typeof address !== "string");
const browser = await chromium.launch({ executablePath, headless: true });

try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${address.port}/`, { waitUntil: "domcontentloaded" });
  const capabilities = await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.register("/sw.js");
    await navigator.serviceWorker.ready;
    const root = await navigator.storage.getDirectory();
    const handle = await root.getFileHandle("qualification.txt", { create: true });
    const writable = await handle.createWritable();
    await writable.write("nuriteo-browser-qualification");
    await writable.close();
    const contents = await (await handle.getFile()).text();
    await root.removeEntry("qualification.txt");
    await registration.unregister();
    return {
      crossOriginIsolated: globalThis.crossOriginIsolated,
      sharedArrayBuffer: typeof SharedArrayBuffer === "function",
      serviceWorker: registration.active !== null || registration.waiting !== null || registration.installing !== null,
      opfs: contents === "nuriteo-browser-qualification"
    };
  });
  assert.deepEqual(capabilities, {
    crossOriginIsolated: true,
    sharedArrayBuffer: true,
    serviceWorker: true,
    opfs: true
  });
  console.log(JSON.stringify({
    status: "pass",
    product: expectedProduct,
    version: browser.version(),
    capabilities
  }));
} finally {
  await browser.close();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
