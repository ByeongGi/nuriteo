import fs from "node:fs";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const matrix = JSON.parse(fs.readFileSync("compat/wasm-tool-adapters.json", "utf8"));
const manifest = JSON.parse(fs.readFileSync("vendor/manifests/wasm-adapters.json", "utf8"));
const source = fs.readFileSync("packages/node-runtime/src/wasm-adapters/policy.ts", "utf8");
const test = fs.readFileSync("packages/node-runtime/test/wasm-adapters.test.ts", "utf8");

assert(matrix.schemaVersion === 1, "unexpected WASM tool adapter schema");
assert(matrix.requirements.supportedAdaptersMustHaveHash === true, "supported adapters must require hash");
assert(matrix.requirements.supportedAdaptersMustHaveExportContract === true, "supported adapters must require export contract");
assert(source.includes("verifyWasmAdapterManifest"), "missing adapter manifest verifier");
assert(matrix.systemWasmBaseline.rustc === "1.97.1", "system WASM Rust baseline drifted");
assert(matrix.systemWasmBaseline.rebuildHashStable === true, "system WASM rebuild evidence missing");

for (const entry of matrix.supportedAdapters) {
  const adapter = manifest.adapters.find((item) => item.name === entry.name);
  assert(adapter, `missing supported adapter: ${entry.name}`);
  assert(adapter.status === "supported", `adapter must be supported: ${entry.name}`);
  assert(/^[0-9a-f]{64}$/.test(adapter.sha256), `adapter must have sha256: ${entry.name}`);
  assert(Object.keys(adapter.exports || {}).length > 0, `adapter must have export contract: ${entry.name}`);
  assert(adapter.fallbackPolicy === entry.fallbackPolicy, `adapter fallback mismatch: ${entry.name}`);
  assert(test.includes(entry.name), `adapter fixture missing ${entry.name}`);
}
const systemWasm = manifest.adapters.find((item) => item.name === "system-wasm");
assert(systemWasm.sha256 === matrix.systemWasmBaseline.sha256, "system WASM baseline hash mismatch");

for (const candidate of matrix.viteEcosystemCandidates) {
  const replacement = manifest.candidateReplacements.find((item) => item.package === candidate.package);
  assert(replacement, `missing Vite ecosystem candidate: ${candidate.package}`);
  assert(replacement.fallbackPolicy === candidate.fallbackPolicy, `fallback policy mismatch: ${candidate.package}`);
  if (candidate.wasmPackage) {
    assert(replacement.wasmPackage === candidate.wasmPackage, `wasm package mismatch: ${candidate.package}`);
    assert(test.includes(candidate.wasmPackage), `fixture missing wasm package: ${candidate.wasmPackage}`);
  } else {
    assert(replacement.wasmPackage === null, `native-only candidate must not claim wasm package: ${candidate.package}`);
    assert(candidate.fallbackPolicy === "deny-native", `native-only candidate must deny native fallback: ${candidate.package}`);
  }
}

console.log("wasm tool adapters ok");
