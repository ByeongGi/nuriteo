import fs from "node:fs";
import path from "node:path";

const baseline = JSON.parse(fs.readFileSync("compat/soak-baseline.json", "utf8"));
const soakSource = fs.readFileSync("tests/system/browser/soak.test.ts", "utf8");

assert(baseline.schemaVersion === 1, "unexpected soak baseline schema");
assert(baseline.requiredIterations >= 1000, "soak baseline must require at least 1000 iterations");
assert(soakSource.includes("SOAK_ITERATIONS"), "browser soak test must support SOAK_ITERATIONS override");
assert(baseline.gate?.status === "pass", "P15-03 gate must pass");

for (const [key, value] of Object.entries(baseline.budgets || {})) {
  assert(value === 0, `leak budget must return to zero: ${key}`);
}
for (const fixture of baseline.fixtures || []) {
  assert(fixture.status === "required", `soak fixture must be required: ${fixture.id}`);
  assert(fs.existsSync(path.resolve(fixture.test)), `missing soak fixture: ${fixture.test}`);
}

console.log("soak baseline ok");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
