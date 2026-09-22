import fs from "node:fs";
import path from "node:path";

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const policy = readJson("compat/runtime-reliability-policy.json");
const soak = readJson("compat/soak-baseline.json");
const browserSmoke = readJson("compat/browser-smoke-results.json");
const supportMatrix = fs.readFileSync("docs/release/support-matrix.md", "utf8");
const browserGrades = fs.readFileSync("docs/productization/browser-support-grades.md", "utf8");

assert(policy.schemaVersion === 1, "unexpected runtime reliability policy schema");
assert(policy.memory.heapCeilingMiB === 256, "memory ceiling must stay aligned with performance baseline");
assert(policy.timeouts.installMs >= 30_000, "install timeout must be at least 30s");
assert(policy.timeouts.cliWorkerMs >= 30_000, "CLI worker timeout must be at least 30s");
assert(policy.timeouts.devServerIdleMs >= 60_000, "dev server idle timeout must be at least 60s");
assert(policy.storage.quotaBytesDefault >= 64 * 1024 * 1024, "default quota must be at least 64MiB");
assert(policy.soak.bootRunTeardownIterations >= soak.requiredIterations, "policy soak iterations must cover baseline");
assert(policy.browserGrades.chrome === "supported", "Chrome must remain supported");
assert(policy.browserGrades.edge === "supported", "Edge must remain supported after the desktop smoke gate");
assert(browserSmoke.results.edge.status === "pass", "Edge support requires passing browser smoke evidence");
assert(
  browserSmoke.results.edge.evidence.includes("tests/preview-service/edge-browser-smoke.test.mjs"),
  "Edge smoke evidence must reference its executable test"
);
assert(browserSmoke.results.safari.status === "hold", "Safari smoke evidence must remain hold until validated");
assert(["hold", "unsupported"].includes(policy.browserGrades.safari), "Safari must be hold or unsupported until SAB validation");
assert(Array.isArray(policy.holdFixtures) && policy.holdFixtures.length === 3, "policy must track the three hold fixtures");

for (const fixture of soak.fixtures) {
  assert(fs.existsSync(path.resolve(fixture.test)), `missing soak fixture: ${fixture.test}`);
}

assert(supportMatrix.includes("Edge"), "support matrix must mention Edge");
assert(supportMatrix.includes("Safari"), "support matrix must mention Safari");
assert(browserGrades.includes("candidate"), "browser grades doc must define candidate");
assert(browserGrades.includes("SharedArrayBuffer"), "browser grades doc must discuss SharedArrayBuffer");
assert(fs.existsSync("tests/browser-host/large-node-modules-stress.test.mjs"), "large node_modules stress test missing");
assert(fs.existsSync("tests/preview-service/workflow-soak.test.mjs"), "workflow soak test missing");
assert(fs.existsSync("tests/preview-service/edge-browser-smoke.test.mjs"), "Edge browser smoke test missing");

console.log(
  `runtime reliability policy ok chrome=${policy.browserGrades.chrome} edge=${policy.browserGrades.edge} safari=${policy.browserGrades.safari}`
);
