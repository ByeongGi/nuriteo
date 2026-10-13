import fs from "node:fs";
import path from "node:path";

const baseline = JSON.parse(fs.readFileSync("compat/performance-baseline.json", "utf8"));

assert(baseline.schemaVersion === 1, "unexpected performance baseline schema");
assert(Array.isArray(baseline.budgets), "performance budgets must be an array");
assert(baseline.gate?.status === "pass", "P15-02 gate must pass");

const requiredIds = new Set([
  "boot-runtime",
  "npm-install-local-plan",
  "pnpm-install-local-plan",
  "vite-product-dev-adapter",
  "vite-product-hmr-adapter",
  "vite-product-build-adapter",
  "runtime-memory-heap-limit"
]);

for (const budget of baseline.budgets) {
  requiredIds.delete(budget.id);
  assert(budget.status === "pass" || budget.status === "blocked", `invalid budget status: ${budget.id}`);
  if (budget.status === "pass") {
    if (typeof budget.budgetMs === "number") assert(budget.sampleMs <= budget.budgetMs, `${budget.id} exceeded ms budget`);
    if (typeof budget.budgetBytes === "number") assert(budget.sampleBytes <= budget.budgetBytes, `${budget.id} exceeded byte budget`);
  } else {
    assert(typeof budget.blocker === "string" && budget.blocker.length > 0, `${budget.id} blocked without blocker`);
  }
  for (const evidence of budget.evidence || []) {
    assert(fs.existsSync(path.resolve(evidence)), `missing performance evidence file: ${evidence}`);
  }
}

assert(requiredIds.size === 0, `missing performance budget ids: ${[...requiredIds].join(", ")}`);

console.log("performance baseline ok");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
