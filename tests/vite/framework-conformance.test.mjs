import assert from "node:assert/strict";
import fs from "node:fs";

const matrix = JSON.parse(fs.readFileSync(new URL("../../compat/framework-conformance.json", import.meta.url), "utf8"));

assert.equal(matrix.schemaVersion, 1);
assert.equal(matrix.scope.productRuntime, "browser-guest-node-runtime");
assert.equal(matrix.scope.referenceRuntime, "host-node-reference-harness");

const casesById = new Map(matrix.cases.map((entry) => [entry.id, entry]));
for (const id of [
  "vite-vanilla-reference-workflow",
  "vite-react-reference-workflow",
  "vite-vue-reference-workflow",
  "vite-svelte-reference-workflow"
]) {
  const entry = casesById.get(id);
  assert.equal(entry?.runtime, "host-node-reference-harness");
  assert.equal(entry.status, "pass");
}

const reactProduct = casesById.get("vite-react-product-workflow");
assert.equal(reactProduct?.runtime, "browser-guest-node-runtime");
assert.equal(reactProduct.status, "pass");
assert.match(reactProduct.productGap, /actual Vite 8\.2\.0 worker-backed product runtime/i);
assert.match(reactProduct.productGap, /reload recovery/i);

for (const id of ["vite-vue-product-workflow", "vite-svelte-product-workflow"]) {
  const product = casesById.get(id);
  assert.equal(product?.runtime, "browser-guest-node-runtime");
  assert.equal(product.status, "partial-pass");
  assert.match(product.productGap, /actual Vite dev server process/i);
  assert.match(product.productGap, /real Vite server HMR source/i);
}

for (const entry of matrix.cases) {
  assert.ok(entry.evidence.length > 0, `${entry.id} must reference evidence`);
  for (const evidence of entry.evidence) {
    assert.equal(fs.existsSync(new URL(`../../${evidence}`, import.meta.url)), true, `${entry.id} evidence missing: ${evidence}`);
  }
}

assert.equal(matrix.gate.id, "PG11");
assert.equal(matrix.gate.status, "not-pass");
assert.ok(matrix.gate.requiredToPass.length >= 3);
assert.match(matrix.gate.reason, /Vite React.*pass/i);

console.log("framework conformance matrix test ok");
