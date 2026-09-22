import fs from "node:fs";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const matrix = JSON.parse(fs.readFileSync("compat/non-js-tooling-candidates.json", "utf8"));
const document = fs.readFileSync("docs/productization/non-js-tooling-candidates.md", "utf8");

assert(matrix.schemaVersion === 2, "unexpected non-JS tooling schema");
assert(matrix.status === "non-js-tooling-product-adapters-supported", "non-JS tooling product adapters are incomplete");
assert(matrix.decisionCriteria.productValue.length >= 3, "product value criteria incomplete");
assert(matrix.decisionCriteria.maintenanceCost.length >= 4, "maintenance cost criteria incomplete");
assert(matrix.decisionCriteria.runtimeFit.includes("no direct TCP"), "runtime fit must reject direct TCP");

const candidates = new Map(matrix.candidates.map((candidate) => [candidate.id, candidate]));
for (const id of ["jq-wasm", "sqlite-wasm", "python-wasi", "git-wasm", "docker-linux-binary"]) {
  assert(candidates.has(id), `missing non-JS tooling candidate: ${id}`);
  assert(document.includes(id), `candidate document missing ${id}`);
}
for (const id of matrix.firstSupportLane) {
  const candidate = candidates.get(id);
  assert(candidate?.status === "supported", `first support lane must contain supported adapters: ${id}`);
  assert(candidate.requiredBeforeSupport.length === 0, `supported adapter still has unresolved validation work: ${id}`);
  assert(candidate.package?.version, `supported adapter package is not pinned: ${id}`);
  assert(candidate.package?.registryIntegrity?.startsWith("sha512-"), `supported adapter registry integrity missing: ${id}`);
  assert(/^[a-f0-9]{64}$/.test(candidate.artifact?.sha256 || ""), `supported adapter artifact hash missing: ${id}`);
  assert(candidate.artifact?.bytes > 0, `supported adapter artifact size missing: ${id}`);
  assert(candidate.filesystem?.result === "pass" || candidate.filesystem?.result === "conditional-pass", `filesystem validation missing: ${id}`);
  assert(candidate.credentialsAndNetwork?.result === "pass", `credential/network validation missing: ${id}`);
  assert(candidate.credentialsAndNetwork?.directTcp === "deny", `direct TCP must remain denied: ${id}`);
  assert(candidate.performance?.result === "pass", `performance validation missing: ${id}`);
  assert(candidate.productSurface?.status === "pass", `product surface missing: ${id}`);
  for (const fixture of candidate.fixtures || []) assert(fs.existsSync(fixture), `validation fixture missing: ${fixture}`);
}
assert(candidates.get("jq-wasm")?.durability.result === "not-applicable", "jq durability must be explicitly not applicable");
assert(candidates.get("sqlite-wasm")?.durability.result === "pass", "sqlite durability fixture must pass");
assert(candidates.get("sqlite-wasm")?.credentialsAndNetwork.tcpDatabaseDiagnostic === "required", "sqlite must not be presented as a TCP database");
assert(candidates.get("jq-wasm")?.productSurface.command.startsWith("jq "), "jq product command is missing");
assert(candidates.get("sqlite-wasm")?.productSurface.worker === "dedicated-worker-per-client", "sqlite must use a dedicated worker client");
assert(candidates.get("sqlite-wasm")?.productSurface.namespace === "projectId + database", "sqlite project namespace is missing");
assert(fs.readFileSync("packages/node-runtime/src/index.ts", "utf8").includes("createJqProjectAdapter"), "jq project adapter must be exported");
assert(fs.readFileSync("packages/browser-host/src/index.ts", "utf8").includes("createSqliteProjectClient"), "sqlite project client must be exported");
assert(fs.readFileSync("tests/browser/fixtures/sqlite-opfs-worker.mjs", "utf8").includes("projectId"), "sqlite worker must enforce a project namespace");
assert(candidates.get("python-wasi")?.status === "hold", "python must stay hold until support surface is proven");
assert(candidates.get("git-wasm")?.status === "hold", "git must stay hold until credential/network/storage phase exists");
assert(candidates.get("docker-linux-binary")?.status === "unsupported", "docker must remain unsupported");
assert(matrix.excludedByDefault.includes("arbitrary-linux-binary"), "arbitrary Linux binaries must be excluded by default");

console.log("non-JS tooling candidates ok");
