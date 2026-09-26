import assert from "node:assert/strict";
import fs from "node:fs";

import { chromium } from "@playwright/test";

import { startHarnessServer } from "../../harness/browser-server.ts";

const chromePath = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
if (!fs.existsSync(chromePath)) throw new Error(`Chrome not found at ${chromePath}`);

const server = await startHarnessServer();
const browser = await chromium.launch({ headless: true, executablePath: chromePath });
try {
  const page = await browser.newPage();
  await page.goto(`${server.url}/tests/harness/browser-runner.html`, { waitUntil: "load" });
  const result = await page.evaluate(async () => {
    async function runWorker(message) {
      const worker = new Worker("/tests/system/browser/fixtures/sqlite-opfs-worker.mjs", { type: "module" });
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

  const git = await page.evaluate(async () => {
    const worker = new Worker("/tests/system/browser/fixtures/git-wasm-worker.mjs", { type: "module" });
    try {
      return await new Promise((resolve, reject) => {
        const id = crypto.randomUUID();
        const timeout = setTimeout(() => reject(new Error("Git WASM browser fixture timed out")), 10_000);
        worker.addEventListener("message", (event) => {
          if (event.data?.id !== id) return;
          clearTimeout(timeout);
          resolve(event.data);
        });
        worker.addEventListener("error", (event) => {
          clearTimeout(timeout);
          reject(new Error(event.message));
        }, { once: true });
        worker.postMessage({ id });
      });
    } finally {
      worker.terminate();
    }
  });
  assert.equal(git.ok, true, git.error);
  assert.equal(git.hash, "5cd5df122c066f63c1a940e66fb126a0a35f44b7c0f1c9801b1c1007078eb0f9");
  assert.equal(git.bytes, 862879);
  assert.equal(git.init.exitCode, 0);
  assert.match(git.before.stdout, /\?\? message\.txt/);
  assert.equal(git.commit.exitCode, 0);
  assert.equal(git.clean.stdout, "");
  assert.match(git.log.stdout, /^[a-f0-9]{40} browser fixture\n$/);
  assert.equal(git.reopenedStatus.stdout, "");
  assert.equal(git.reopenedLog.stdout, git.log.stdout);
  assert.equal(git.persistedHead, true);
  assert.equal(git.persistedIndex, true);
  assert.ok(git.elapsedMs <= 5000, `Git WASM browser fixture exceeded 5000ms: ${git.elapsedMs}`);

  const opfsGit = await page.evaluate(async () => {
    const createClient = () => {
      const worker = new Worker("/tests/system/browser/fixtures/git-opfs-worker.mjs", { type: "module" });
      return {
        request(message, timeoutMs = 15_000) {
          return new Promise((resolve, reject) => {
            const id = crypto.randomUUID();
            const timeout = setTimeout(() => reject(new Error(`Git OPFS ${message.action} timed out`)), timeoutMs);
            const onMessage = (event) => {
              if (event.data?.id !== id) return;
              clearTimeout(timeout);
              worker.removeEventListener("message", onMessage);
              resolve(event.data);
            };
            worker.addEventListener("message", onMessage);
            worker.postMessage({ id, ...message });
          });
        },
        close() { worker.terminate(); }
      };
    };

    const projectId = `opfs-${crypto.randomUUID()}`;
    const corruptProjectId = `corrupt-${crypto.randomUUID()}`;
    const malformedProjectId = `malformed-${crypto.randomUUID()}`;
    const first = createClient();
    const startedAt = performance.now();
    const init = await first.request({ projectId, action: "init" });
    const write = await first.request({ projectId, action: "write-file", path: "main.txt", contents: "opfs persisted\n" });
    const before = await first.request({ projectId, action: "status" });
    const add = await first.request({ projectId, action: "add", path: "main.txt" });
    const commit = await first.request({ projectId, action: "commit", message: "opfs commit", author: { name: "OPFS Fixture", email: "opfs@example.test" } });
    const log = await first.request({ projectId, action: "log", maxEntries: 1 });
    first.close();

    const reopened = createClient();
    const statusAfterReopen = await reopened.request({ projectId, action: "status" });
    const logAfterReopen = await reopened.request({ projectId, action: "log", maxEntries: 1 });
    const readAfterReopen = await reopened.request({ projectId, action: "read-file", path: "main.txt" });
    const symlinkImport = await reopened.request({ projectId, action: "import-symlink", path: "link.txt" });
    const oversized = await reopened.request({ projectId, action: "write-file", path: "large.bin", contents: "x".repeat(16 * 1024 * 1024 + 1) }, 30_000);
    await reopened.request({ projectId, action: "remove" });

    const corrupt = createClient();
    await corrupt.request({ projectId: corruptProjectId, action: "init" });
    await corrupt.request({ projectId: corruptProjectId, action: "corrupt-head" });
    const corruption = await corrupt.request({ projectId: corruptProjectId, action: "status" });
    await corrupt.request({ projectId: corruptProjectId, action: "remove" });
    corrupt.close();

    const malformed = createClient();
    await malformed.request({ projectId: malformedProjectId, action: "init" });
    const malformedObject = await malformed.request({ projectId: malformedProjectId, action: "inject-malformed-object" });
    const malformedValidation = await malformed.request({ projectId: malformedProjectId, action: "validate-object", oid: malformedObject.oid });
    await malformed.request({ projectId: malformedProjectId, action: "remove" });
    malformed.close();
    reopened.close();
    return {
      elapsedMs: performance.now() - startedAt,
      init,
      write,
      before,
      add,
      commit,
      log,
      statusAfterReopen,
      logAfterReopen,
      readAfterReopen,
      symlinkImport,
      oversized,
      corruption,
      malformedValidation
    };
  });
  for (const [name, operation] of Object.entries({ init: opfsGit.init, write: opfsGit.write, add: opfsGit.add, commit: opfsGit.commit, log: opfsGit.log })) {
    assert.equal(operation.ok, true, `${name}: ${operation.error}`);
  }
  assert.equal(opfsGit.init.variant, "pthreads");
  assert.equal(opfsGit.init.artifactSha256, "ec1807f0ad7924bd179f1a864b645d2cd44149ca40cb4492ef9cff7425ab4c83");
  assert.equal(opfsGit.before.ok, true, opfsGit.before.error);
  assert.equal(opfsGit.statusAfterReopen.ok, true, opfsGit.statusAfterReopen.error);
  assert.equal(opfsGit.statusAfterReopen.stdout, "");
  assert.match(opfsGit.log.headOid, /^[a-f0-9]{40}$/);
  assert.equal(opfsGit.logAfterReopen.headOid, opfsGit.log.headOid);
  assert.equal(opfsGit.readAfterReopen.ok, true, opfsGit.readAfterReopen.error);
  assert.equal(opfsGit.readAfterReopen.contents, "opfs persisted\n");
  assert.equal(opfsGit.symlinkImport.ok, false);
  assert.equal(opfsGit.symlinkImport.code, "EGITSYMLINK");
  assert.equal(opfsGit.oversized.ok, false);
  assert.equal(opfsGit.oversized.code, "EGITFILELIMIT");
  assert.equal(opfsGit.corruption.ok, false);
  assert.equal(opfsGit.corruption.code, "EGITCORRUPT");
  assert.equal(opfsGit.malformedValidation.ok, false);
  assert.equal(opfsGit.malformedValidation.code, "EGITCORRUPT");
  assert.ok(opfsGit.elapsedMs <= 15_000, `Git OPFS fixture exceeded 15000ms: ${opfsGit.elapsedMs}`);
} finally {
  await browser.close();
  await server.close();
}

console.log("browser non-JS tooling test ok");
