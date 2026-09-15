import assert from "node:assert/strict";
import fs from "node:fs";

const matrix = JSON.parse(fs.readFileSync(new URL("../../compat/nextjs-compatibility.json", import.meta.url), "utf8"));

assert.equal(matrix.schemaVersion, 1);
assert.equal(matrix.nextVersion, "16.3.5");
assert.equal(matrix.packageFacts.bin, "dist/bin/next");
assert.equal(matrix.packageFacts.nodeEngine, ">=20.9.0");
assert.equal(matrix.packageFacts.wasmSwcPackage, "@next/swc-wasm-nodejs@16.3.5");
assert.ok(matrix.packageFacts.nativeOptionalDependencies.includes("@next/swc-darwin-arm64"));
assert.ok(matrix.packageFacts.nativeOptionalDependencies.includes("sharp"));

const capabilities = new Map(matrix.capabilities.map((entry) => [entry.id, entry]));
assert.equal(capabilities.get("next-app-router-dev").status, "hold");
assert.equal(capabilities.get("next-app-router-build").status, "hold");
assert.equal(capabilities.get("next-static-export").status, "candidate");
assert.equal(capabilities.get("next-native-swc").status, "unsupported");
assert.equal(capabilities.get("next-wasm-swc").status, "candidate");
assert.match(capabilities.get("next-native-swc").reason, /Native/);
assert.match(matrix.gate.supportDecision, /Do not claim Next\.js product support yet/);

console.log("nextjs compatibility matrix test ok");
