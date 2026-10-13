import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  RuntimeAssetError,
  resolveRuntimeAssetRevision
} from "../src/runtime/runtime-assets.ts";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nuriteo-runtime-assets-"));
const first = path.join(temporaryRoot, "first");
const second = path.join(temporaryRoot, "second");

try {
  const firstOutput = buildAssets(first);
  const secondOutput = buildAssets(second);
  assert.match(firstOutput, /runtime assets [0-9a-f]{64} \(10 files\)/u);
  assert.equal(firstOutput, secondOutput, "same source inputs must produce one revision");

  const manifest = readManifest(first);
  assert.match(manifest.revision, /^[0-9a-f]{64}$/u);
  assert.deepEqual(manifest.files.map((file) => file.path), [...manifest.files.map((file) => file.path)].sort(byteOrder));
  const expectedRevision = sha256(Buffer.from(JSON.stringify(manifest.files)));
  assert.equal(manifest.revision, expectedRevision);
  for (const file of manifest.files) {
    const contents = fs.readFileSync(path.join(first, manifest.revision, file.path));
    assert.equal(contents.byteLength, file.sizeBytes, `${file.path} size`);
    assert.equal(sha256(contents), file.sha256, `${file.path} integrity`);
  }
  const processWorker = fs.readFileSync(path.join(first, manifest.revision, "process-worker.js"), "utf8");
  const nestedWorker = fs.readFileSync(path.join(first, manifest.revision, "cli-nested-worker.js"), "utf8");
  const rolldown = fs.readFileSync(path.join(first, manifest.revision, "vendor/vite-8.2.0/rolldown-wasi-binding.mjs"), "utf8");
  assert.doesNotMatch(processWorker, /cli-nested-worker\.ts|new URL\("\.\.\/vendor\/|\/runtime\/system_wasm/u);
  assert.doesNotMatch(nestedWorker, /new URL\("\.\.\/vendor\//u);
  assert.doesNotMatch(rolldown, /"\/vendor\/vite-8\.2\.0\/assets/u);
  assert.match(processWorker, /cli-nested-worker\.js/u);
  assert.match(rolldown, /new URL\("\.\/assets\/rolldown-binding\.wasm",\s*import\.meta\.url\)/u);
} finally {
  fs.rmSync(temporaryRoot, { force: true, recursive: true });
}

const revision = "a".repeat(64);
const originalFetch = globalThis.fetch;
try {
  globalThis.fetch = async () => new Response(JSON.stringify({ schemaVersion: 1, revision }), {
    headers: { "content-length": "96", "content-type": "application/json" }
  });
  assert.equal(await resolveRuntimeAssetRevision(), revision);
  assert.equal(await resolveRuntimeAssetRevision("b".repeat(64)), "b".repeat(64));

  globalThis.fetch = async () => new Response("not-json");
  await assert.rejects(resolveRuntimeAssetRevision(), (error: unknown) =>
    error instanceof RuntimeAssetError && error.code === "RUNTIME_ASSET_MANIFEST_INVALID");

  globalThis.fetch = async () => new Response(JSON.stringify({ schemaVersion: 1, revision: "invalid" }));
  await assert.rejects(resolveRuntimeAssetRevision(), (error: unknown) =>
    error instanceof RuntimeAssetError && error.code === "RUNTIME_ASSET_REVISION_INVALID");

  globalThis.fetch = async () => new Response("x".repeat(256 * 1024 + 1));
  await assert.rejects(resolveRuntimeAssetRevision(), (error: unknown) =>
    error instanceof RuntimeAssetError && error.code === "RUNTIME_ASSET_MANIFEST_INVALID");

  const abort = new AbortController();
  globalThis.fetch = async (_input, init) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
  });
  const pending = resolveRuntimeAssetRevision(undefined, abort.signal);
  abort.abort();
  await assert.rejects(pending, (error: unknown) =>
    error instanceof RuntimeAssetError && error.code === "RUNTIME_ASSET_MANIFEST_UNAVAILABLE");
} finally {
  globalThis.fetch = originalFetch;
}

function buildAssets(outputRoot: string): string {
  const result = spawnSync(process.execPath, [
    "--experimental-strip-types",
    path.join(webRoot, "tooling/build-runtime-assets.ts"),
    "--out-dir",
    outputRoot
  ], { cwd: webRoot, encoding: "utf8", maxBuffer: 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

interface Manifest {
  schemaVersion: number;
  revision: string;
  files: Array<{ path: string; sha256: string; sizeBytes: number }>;
}

function readManifest(root: string): Manifest {
  return JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8")) as Manifest;
}

function sha256(value: Uint8Array): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function byteOrder(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}
