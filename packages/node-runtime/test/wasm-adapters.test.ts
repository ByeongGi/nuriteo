import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { createWasmAdapterPolicy, createWasmAdapterRegistry, rejectNativeAddon, verifyWasmAdapterManifest } from "../../node-runtime/src/index.ts";

const root = new URL("../../..", import.meta.url).pathname;
const manifest = JSON.parse(fs.readFileSync(path.join(root, "vendor/manifests/wasm-adapters.json"), "utf8"));
const registry = createWasmAdapterRegistry(manifest, { root });
verifyWasmAdapterManifest(manifest);
const loaded = await registry.instantiate("system-wasm");

assert.equal(loaded.hash, registry.resolve("system-wasm").sha256);
assert.equal(loaded.instance.exports.nuriteo_abi_version(), 1);
assert.ok(loaded.instance.exports.memory instanceof WebAssembly.Memory);

const browserLike = createWasmAdapterRegistry(manifest, {
  root,
  readBytes(adapter) {
    return fs.readFileSync(path.join(root, adapter.path));
  },
  async sha256(bytes) {
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }
});
assert.equal((await browserLike.instantiate("system-wasm")).instance.exports.nuriteo_abi_version(), 1);

let importProviderCalled = false;
const asyncImports = createWasmAdapterRegistry(manifest, {
  root,
  imports: async () => {
    importProviderCalled = true;
    return {};
  },
  resolveWorkerAsset: (assetPath) => `https://example.test/vendor/${assetPath}`
});
assert.equal((await asyncImports.instantiate("system-wasm")).instance.exports.nuriteo_abi_version(), 1);
assert.equal(importProviderCalled, true);
assert.equal((await asyncImports.workerAsset("system-wasm", "thread-worker.js")).href, "https://example.test/vendor/thread-worker.js");
await assert.rejects(
  createWasmAdapterRegistry(manifest).workerAsset("system-wasm", "worker.js"),
  (error) => error.code === "ENOWORKERASSETRESOLVER"
);

const tampered = structuredClone(manifest);
tampered.adapters[0].sha256 = "0".repeat(64);
await assert.rejects(
  createWasmAdapterRegistry(tampered, { root }).instantiate("system-wasm"),
  (error) => error.code === "EINTEGRITY"
);

await assert.rejects(
  createWasmAdapterRegistry({ ...manifest, adapters: [{ ...manifest.adapters[0], exports: { missing: "function" } }] }, { root }).instantiate("system-wasm"),
  (error) => error.code === "EBADWASMEXPORT"
);

assert.throws(
  () => rejectNativeAddon("esbuild"),
  (error) => error.code === "ENATIVEADDON"
);

const policy = createWasmAdapterPolicy(manifest);
assert.equal(policy.resolvePackage("@rolldown/binding-darwin-arm64").wasmPackage, "@rolldown/binding-wasm32-wasi");
assert.equal(policy.resolvePackage("@rolldown/binding-darwin-arm64").fallbackPolicy, "prefer-wasm");
assert.equal(policy.resolvePackage("@esbuild/darwin-arm64").wasmPackage, "esbuild-wasm");
assert.equal(policy.resolvePackage("@esbuild/darwin-arm64").status, "candidate-until-esbuild-wasm-artifact-is-integrity-pinned");
assert.equal(policy.resolvePackage("postcss").action, "allow-js");
assert.throws(
  () => policy.resolvePackage("lightningcss-darwin-arm64"),
  (error) => error.code === "ENATIVEADDON"
);
const missingFallback = structuredClone(manifest);
delete missingFallback.candidateReplacements.find((item) => item.package === "esbuild").fallbackPolicy;
assert.throws(
  () => verifyWasmAdapterManifest(missingFallback),
  (error) => error.code === "ENATIVEADDON"
);

console.log("node runtime wasm adapters test ok");
