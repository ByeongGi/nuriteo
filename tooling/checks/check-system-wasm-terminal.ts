import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";

const buildPath = "target/wasm32-unknown-unknown/debug/system_wasm.wasm";
const productPath = "packages/workspace-runtime/assets/runtime/system_wasm.wasm";
const adapterManifestPath = "vendor/manifests/wasm-adapters.json";
const compatibilityPath = "compat/wasm-tool-adapters.json";

assert.ok(fs.existsSync(buildPath), `missing system WASM build: run pnpm build:wasm before this check`);
assert.ok(fs.existsSync(productPath), "missing preview system WASM asset");

const build = fs.readFileSync(buildPath);
const product = fs.readFileSync(productPath);
assert.ok(build.equals(product), "preview system WASM is stale; rebuild and copy the generated artifact");
assert.ok(product.byteLength > 0 && product.byteLength <= 2 * 1024 * 1024, "preview system WASM size is outside the release bound");

const digest = crypto.createHash("sha256").update(product).digest("hex");
assert.match(digest, /^[a-f0-9]{64}$/);
const manifest = JSON.parse(fs.readFileSync(adapterManifestPath, "utf8"));
const adapter = manifest.adapters.find((entry: { name?: string }) => entry.name === "system-wasm");
assert.equal(adapter?.sha256, digest, "system WASM adapter manifest hash is stale");
const compatibility = JSON.parse(fs.readFileSync(compatibilityPath, "utf8"));
assert.equal(compatibility.systemWasmBaseline?.sha256, digest, "system WASM compatibility baseline hash is stale");
console.log(`system WASM terminal asset ok (${product.byteLength} bytes, sha256 ${digest})`);
