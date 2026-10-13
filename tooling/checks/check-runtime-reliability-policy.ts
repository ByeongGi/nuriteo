import fs from "node:fs";
import path from "node:path";

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const policy = readJson("compat/runtime-reliability-policy.json");
const actualFixtures = readJson("compat/ecosystem-fixture-actual-product-results.json");
const soak = readJson("compat/soak-baseline.json");
const largeFixtureSoak = readJson("compat/large-fixture-restart-soak.json");
const browserWorkerResources = readJson("compat/browser-worker-resource-results.json");
const fixtureCatalog = readJson("compat/ecosystem-fixtures.json");
const browserSmoke = readJson("compat/browser-smoke-results.json");
const supportMatrix = fs.readFileSync("docs/release/support-matrix.md", "utf8");
const browserGrades = fs.readFileSync("docs/productization/browser-support-grades.md", "utf8");

assert(policy.schemaVersion === 1, "unexpected runtime reliability policy schema");
assert(policy.memory.heapCeilingMiB === 256, "memory ceiling must stay aligned with performance baseline");
assert(policy.memory.nodeWorkerV8OldGenerationLimitMiB === 256, "Node worker old generation limit must match policy");
assert(policy.memory.guestWorkspaceLimitBytes === 256 * 1024 * 1024, "guest workspace bytes must match policy");
assert(policy.memory.browserWorkerHeapEnforcement === "unavailable-not-claimed", "browser worker heap must remain an explicitly unavailable browser guarantee");
assert(policy.memory.browserWorkerResourceObservation === "chrome-page-memory-and-worker-target-churn", "browser worker resource observation contract missing");
assert(policy.memory.browserWorkerResourceContract === "preflight-admission-wasm-constructor-workspace-watchdog", "browser product resource contract missing");
assert(policy.memory.browserWorkerAdmissionLimitBytes === 256 * 1024 * 1024, "browser admission limit must remain 256 MiB");
assert(policy.memory.browserWorkerWasmMaximumPages === 32768, "browser WASM page limit must cover the pinned Rspack WASI address space");
assert(policy.memory.browserWorkerWasmMaximumBytes === 2 * 1024 * 1024 * 1024, "browser WASM byte limit must remain 2 GiB");
assert(browserWorkerResources.status === "pass-with-product-resource-contract", "browser worker product resource evidence must pass");
assert(browserWorkerResources.executionHost === "strict-csp-headless-chrome", "browser worker resources must be measured in strict-CSP Chrome");
assert(browserWorkerResources.csp === "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'", "browser worker resource CSP drift");
assert(browserWorkerResources.crossOriginIsolated === true, "browser worker resource probe must be cross-origin isolated");
assert(browserWorkerResources.iterations >= 30 && browserWorkerResources.successfulBoots === browserWorkerResources.iterations, "browser worker churn must run at least 30 successful boots");
assert(browserWorkerResources.forcedBootFailuresAndRecoveries >= 3, "browser worker probe must recover from forced boot failures");
assert(browserWorkerResources.workerTargetsAfter === browserWorkerResources.workerTargetsBefore, "browser worker targets leaked after churn");
assert(browserWorkerResources.productResourceContract.status === "pass", "browser product resource contract must pass");
assert(browserWorkerResources.productResourceContract.admissionLimitBytes === 256 * 1024 * 1024, "browser admission evidence drift");
assert(browserWorkerResources.productResourceContract.wasmMaximumPages === 32768, "browser WASM limit evidence drift");
assert(browserWorkerResources.productResourceContract.workspaceLimitBytes === 256 * 1024 * 1024, "browser workspace limit evidence drift");
assert(browserWorkerResources.productResourceContract.watchdog.includes("terminates"), "browser watchdog evidence missing");
assert(browserWorkerResources.jsHeapHardCap.status === "unavailable-not-claimed", "browser worker hard heap cap must not be claimed");
assert(browserWorkerResources.pageMemory.scope.includes("not a per-Worker hard limit"), "page memory scope must not imply Worker enforcement");
assert(fs.existsSync("tooling/benchmarks/measure-browser-worker-resources.ts"), "browser worker resource probe missing");
assert(fs.existsSync("packages/browser-host/src/resources/browser-resource-policy.ts"), "browser resource policy missing");
assert(fs.existsSync("packages/browser-host/test/runtime-resource-policy.test.ts"), "browser resource policy test missing");
assert(fs.readFileSync("workers/process-worker.ts", "utf8").includes("installWebAssemblyMemoryLimit"), "process worker WASM memory policy missing");
assert(fs.readFileSync("workers/cli-nested-worker.ts", "utf8").includes("installWebAssemblyMemoryLimit"), "nested worker WASM memory policy missing");
assert(fs.readFileSync("tooling/shared/node-thread-cli-worker.ts", "utf8").includes("maxOldGenerationSizeMb: 256"), "Node worker resource limit missing");
assert(fs.readFileSync("packages/node-runtime/src/package-managers/workspace.ts", "utf8").includes("DEFAULT_WORKSPACE_MEMORY_LIMIT_BYTES"), "guest workspace limit missing");
assert(policy.timeouts.installMs >= 30_000, "install timeout must be at least 30s");
assert(policy.timeouts.cliWorkerMs >= 30_000, "CLI worker timeout must be at least 30s");
assert(policy.timeouts.devServerIdleMs >= 60_000, "dev server idle timeout must be at least 60s");
assert(policy.storage.quotaBytesDefault >= 64 * 1024 * 1024, "default quota must be at least 64MiB");
assert(policy.soak.bootRunTeardownIterations >= soak.requiredIterations, "policy soak iterations must cover baseline");
assert(largeFixtureSoak.executionHost === "node-worker-thread" && largeFixtureSoak.nodeVersion === "22.23.0", "large fixture soak must identify its Node worker host");
assert(largeFixtureSoak.fixture === "awe-templates-react-starter" && /^[0-9a-f]{40}$/.test(largeFixtureSoak.revision), "large fixture soak must pin its source revision");
assert(fixtureCatalog.fixtures.find((fixture) => fixture.id === largeFixtureSoak.fixture)?.revision === largeFixtureSoak.revision, "large fixture soak revision must match catalog");
assert(largeFixtureSoak.iterations.length >= 3, "large fixture soak needs three consecutive runs");
for (const iteration of largeFixtureSoak.iterations) {
  assert(iteration.status === "pass" && iteration.score === 100, "large fixture soak iteration must pass");
  assert(["install", "dev-preview", "edit-hmr", "build-dist"].every((stage) => iteration.stages.includes(stage)), "large fixture soak iteration must cover every product stage");
}
assert(policy.browserGrades.chrome === "supported", "Chrome must remain supported");
assert(policy.browserGrades.edge === "supported", "Edge must remain supported after the desktop smoke gate");
assert(browserSmoke.results.edge.status === "pass", "Edge support requires passing browser smoke evidence");
assert(
  browserSmoke.results.edge.evidence.some((entry) => entry.startsWith("git-history:")),
  "Edge smoke evidence must retain a historical source reference"
);
assert(policy.browserGrades.safari === "supported", "Safari must be supported after the desktop product smoke gate");
assert(browserSmoke.results.safari.status === "pass", "Safari support requires passing browser smoke evidence");
assert(
  browserSmoke.results.safari.evidence.some((entry) => entry.startsWith("git-history:")),
  "Safari smoke evidence must retain a historical source reference"
);
assert(
  browserSmoke.results.safari.limitations.some((limitation) => limitation.includes("iOS")),
  "Safari evidence must keep the mobile coverage limitation explicit"
);
assert(Array.isArray(policy.holdFixtures), "policy must list current held public fixtures");
assert(
  policy.holdFixtures.map((fixture) => fixture.id).sort().join(",") === actualFixtures.results.filter((result) => result.status === "hold").map((result) => result.id).sort().join(","),
  "policy held fixtures must match current actual-product evidence"
);

for (const fixture of soak.fixtures) {
  assert(fs.existsSync(path.resolve(fixture.test)), `missing soak fixture: ${fixture.test}`);
}

assert(supportMatrix.includes("Edge"), "support matrix must mention Edge");
assert(supportMatrix.includes("Safari"), "support matrix must mention Safari");
assert(browserGrades.includes("candidate"), "browser grades doc must define candidate");
assert(browserGrades.includes("SharedArrayBuffer"), "browser grades doc must discuss SharedArrayBuffer");
assert(fs.existsSync("packages/browser-host/test/large-node-modules-stress.test.ts"), "large node_modules stress test missing");
assert(fs.existsSync("packages/workspace-runtime/test/ide-offline-soak.test.ts"), "workspace Runtime soak test missing");

console.log(
  `runtime reliability policy ok chrome=${policy.browserGrades.chrome} edge=${policy.browserGrades.edge} safari=${policy.browserGrades.safari}`
);
