import assert from "node:assert/strict";
import fs from "node:fs";

const matrix = JSON.parse(fs.readFileSync(new URL("../../../../compat/nextjs-compatibility.json", import.meta.url), "utf8"));

assert.equal(matrix.schemaVersion, 5);
assert.equal(matrix.nextVersion, "15.1.9");
assert.equal(matrix.publicGrade, "product-preview");
assert.equal(matrix.fullRuntimeGrade, "candidate");
assert.equal(matrix.productSupportClaim, true);
assert.match(matrix.productSupportClaimScope, /App Router preview adapter/);
assert.equal(matrix.packageFacts.bin, "dist/bin/next");
assert.equal(matrix.packageFacts.nodeEngine, "^18.18.0 || ^19.8.0 || >=20.0.0");
assert.equal(matrix.packageFacts.wasmSwcPackage, "@next/swc-wasm-nodejs");
assert.equal(matrix.packageFacts.wasmSwcVersion, "15.1.9");
assert.equal(matrix.packageFacts.nativeAddonPolicy, "unsupported");
assert.match(matrix.packageFacts.wasmSwcIntegrity, /^sha512-/);
assert.ok(matrix.packageFacts.nativeOptionalDependencies.includes("@next/swc-darwin-arm64"));
assert.ok(matrix.packageFacts.nativeOptionalDependencies.includes("sharp"));

const capabilities = new Map(matrix.capabilities.map((entry) => [entry.id, entry]));
assert.equal(capabilities.get("next-app-router-preview-adapter").status, "supported");
assert.equal(capabilities.get("next-app-router-multi-route").status, "supported");
assert.equal(capabilities.get("next-app-router-build-adapter").status, "supported");
assert.equal(capabilities.get("next-cli-artifact-execution").status, "candidate");
assert.equal(capabilities.get("next-app-router-dev").status, "candidate");
assert.equal(capabilities.get("next-app-router-build").status, "candidate");
assert.equal(capabilities.get("next-static-export").status, "candidate");
assert.equal(capabilities.get("next-native-swc").status, "unsupported");
assert.equal(capabilities.get("next-wasm-swc").status, "candidate");
assert.equal(capabilities.get("next-rsc-server-actions").status, "candidate");
assert.equal(capabilities.get("next-middleware-edge").status, "candidate");
assert.equal(capabilities.get("next-isr-image").status, "candidate");
assert.match(capabilities.get("next-native-swc").reason, /Native/);
assert.equal(matrix.gate.status, "product-preview-claimed");
assert.match(matrix.gate.supportDecision, /preview adapter remains the public product-supported surface/);
assert.match(matrix.gate.supportDecision, /candidate-grade/);
assert.equal(matrix.browserWorker.status, "hold");
assert.equal(matrix.browserWorker.blockerCode, "ECLICSPUNSUPPORTED");
assert.equal(matrix.security.status, "hold");

console.log("nextjs compatibility matrix test ok");
