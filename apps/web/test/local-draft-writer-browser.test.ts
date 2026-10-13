import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "@playwright/test";
import { build } from "esbuild";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nuriteo-local-draft-writer-"));
await build({
  bundle: true,
  entryPoints: [path.join(webRoot, "test/fixtures/local-draft-writer.ts")],
  format: "esm",
  outfile: path.join(fixtureRoot, "fixture.js"),
  platform: "browser",
  target: "es2022"
});
fs.writeFileSync(path.join(fixtureRoot, "index.html"), '<!doctype html><meta charset="utf-8"><script type="module" src="/fixture.js"></script>\n');

const server = http.createServer((request, response) => {
  const file = new URL(request.url ?? "/", "http://localhost").pathname === "/" ? "index.html" : "fixture.js";
  response.setHeader("Content-Type", file.endsWith(".js") ? "text/javascript; charset=utf-8" : "text/html; charset=utf-8");
  response.end(fs.readFileSync(path.join(fixtureRoot, file)));
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert(address && typeof address !== "string");

const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext();
  const owner = await context.newPage();
  const contender = await context.newPage();
  const url = `http://127.0.0.1:${address.port}/`;
  await Promise.all([
    owner.goto(url, { waitUntil: "domcontentloaded" }),
    contender.goto(url, { waitUntil: "domcontentloaded" })
  ]);
  await Promise.all([
    owner.waitForFunction(() => Boolean(window.__localDraftWriterFixture)),
    contender.waitForFunction(() => Boolean(window.__localDraftWriterFixture))
  ]);

  const namespace = "0199ee6c-c777-7000-8000-00000000d001:0199ee6c-c777-7000-8000-00000000d002";
  assert.equal(await owner.evaluate((value) => window.__localDraftWriterFixture.acquire(value), namespace), true);
  assert.equal(await contender.evaluate((value) => window.__localDraftWriterFixture.acquire(value), namespace), false);
  assert.deepEqual(await contender.evaluate(() => window.__localDraftWriterFixture.snapshot()), { lost: 0, status: "conflict" });

  await contender.evaluate(() => window.__localDraftWriterFixture.takeOver());
  await owner.waitForFunction(() => window.__localDraftWriterFixture.snapshot().lost === 1);
  assert.deepEqual(await owner.evaluate(() => window.__localDraftWriterFixture.snapshot()), { lost: 1, status: "lost" });
  assert.deepEqual(await contender.evaluate(() => window.__localDraftWriterFixture.snapshot()), { lost: 0, status: "writer" });

  await Promise.all([
    owner.evaluate(() => window.__localDraftWriterFixture.release()),
    contender.evaluate(() => window.__localDraftWriterFixture.release())
  ]);

  const blockedNamespace = `${namespace}:blocked`;
  await owner.evaluate((value) => window.__localDraftWriterFixture.holdRaw(value), blockedNamespace);
  assert.equal(await contender.evaluate((value) => window.__localDraftWriterFixture.acquire(value), blockedNamespace), false);
  const pendingTakeover = contender.evaluate(async () => {
    try {
      await window.__localDraftWriterFixture.takeOver();
      return "acquired";
    } catch {
      return "cancelled";
    }
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  const cancelStartedAt = Date.now();
  await contender.evaluate(() => window.__localDraftWriterFixture.release());
  assert.equal(await pendingTakeover, "cancelled");
  assert(Date.now() - cancelStartedAt < 1_000, "dispose must abort a pending writer takeover without waiting for its deadline");
  owner.evaluate(() => window.__localDraftWriterFixture.releaseRaw());

  await context.close();
  console.log("RT-005 Local Draft writer browser test ok (conflict, confirmed takeover, previous writer loss, pending cancellation)");
} finally {
  await browser.close();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  fs.rmSync(fixtureRoot, { force: true, recursive: true });
}
