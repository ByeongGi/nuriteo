import assert from "node:assert/strict";
import fs from "node:fs";

const matrix = JSON.parse(fs.readFileSync(new URL("../../../../compat/framework-conformance.json", import.meta.url), "utf8"));
const actual = JSON.parse(fs.readFileSync(new URL("../../../../compat/framework-actual-validation.json", import.meta.url), "utf8"));

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

for (const id of ["vite-vue-product-workflow", "vite-svelte-product-workflow"]) {
  const product = casesById.get(id);
  assert.equal(product?.runtime, "browser-guest-node-runtime");
  assert.equal(product.status, "supported");
  assert.ok(product.evidence.includes("tests/compatibility/frameworks/vite/vite-vue-svelte-actual.test.ts"));
  assert.ok(product.evidence.includes("compat/framework-actual-validation.json"));
  assert.ok(product.evidence.includes("compat/framework-product-support.json"));
  assert.match(product.supportContract, /npm\/pnpm install/i);
}

for (const entry of matrix.cases) {
  assert.ok(entry.evidence.length > 0, `${entry.id} must reference evidence`);
  for (const evidence of entry.evidence) {
    const evidencePath = evidence.includes("#") ? evidence.slice(0, evidence.indexOf("#")) : evidence;
    assert.equal(fs.existsSync(new URL(`../../../../${evidencePath}`, import.meta.url)), true, `${entry.id} evidence missing: ${evidence}`);
  }
}

const byFramework = new Map(actual.results.map((entry) => [entry.framework, entry]));
assert.equal(byFramework.get("vite-react")?.grade, "supported");
assert.equal(byFramework.get("vite-vue")?.validation, "actual-worker-backed");
assert.equal(byFramework.get("vite-svelte")?.validation, "actual-worker-backed");
assert.equal(byFramework.get("vite-vue")?.grade, "supported");
assert.equal(byFramework.get("vite-svelte")?.grade, "supported");
assert.equal(byFramework.get("nextjs")?.grade, "product-preview");
assert.equal(byFramework.get("nextjs")?.validation, "product-preview-adapter");
assert.equal(byFramework.get("nextjs-full-runtime")?.grade, "product-supported");
assert.equal(byFramework.get("nextjs-full-runtime")?.validation, "actual-guest-runtime");
assert.equal(actual.gate.status, "pass");

assert.equal(matrix.gate.id, "SG25");
assert.equal(matrix.gate.status, "pass");
assert.ok(matrix.gate.requiredToPass.length >= 3);

console.log("framework conformance matrix test ok");
