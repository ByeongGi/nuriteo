import assert from "node:assert/strict";
import fs from "node:fs";

const matrix = JSON.parse(fs.readFileSync(new URL("../../compat/nextjs-compatibility.json", import.meta.url), "utf8"));

assert.equal(matrix.schemaVersion, 2);
assert.equal(matrix.nextVersion, "15.1.0");
assert.equal(matrix.publicGrade, "product-preview");
assert.equal(matrix.productSupportClaim, true);
assert.match(matrix.productSupportClaimScope, /App Router preview adapter/);
assert.equal(matrix.packageFacts.bin, "dist/bin/next");
assert.equal(matrix.packageFacts.nodeEngine, ">=20.9.0");
assert.equal(matrix.packageFacts.wasmSwcPackage, "@next/swc-wasm-nodejs");
assert.ok(matrix.packageFacts.nativeOptionalDependencies.includes("@next/swc-darwin-arm64"));
assert.ok(matrix.packageFacts.nativeOptionalDependencies.includes("sharp"));

const capabilities = new Map(matrix.capabilities.map((entry) => [entry.id, entry]));
assert.equal(capabilities.get("next-app-router-preview-adapter").status, "supported");
assert.equal(capabilities.get("next-app-router-multi-route").status, "supported");
assert.equal(capabilities.get("next-app-router-build-adapter").status, "supported");
assert.equal(capabilities.get("next-app-router-dev").status, "hold");
assert.equal(capabilities.get("next-app-router-build").status, "hold");
assert.equal(capabilities.get("next-static-export").status, "candidate");
assert.equal(capabilities.get("next-native-swc").status, "unsupported");
assert.equal(capabilities.get("next-wasm-swc").status, "candidate");
assert.match(capabilities.get("next-native-swc").reason, /Native/);
assert.equal(matrix.gate.status, "product-preview-claimed");
assert.match(matrix.gate.supportDecision, /App Router preview adapter as product-supported/);
assert.match(matrix.gate.supportDecision, /Do not claim full next CLI/);

console.log("nextjs compatibility matrix test ok");
