import fs from "node:fs";
import crypto from "node:crypto";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const matrix = JSON.parse(fs.readFileSync("compat/non-js-tooling-candidates.json", "utf8"));
const artifactManifest = JSON.parse(fs.readFileSync("vendor/manifests/non-js-runtime-artifacts.json", "utf8"));
const document = fs.readFileSync("docs/productization/non-js-tooling-candidates.md", "utf8");

assert(matrix.schemaVersion === 5, "unexpected non-JS tooling schema");
assert(matrix.status === "supported-adapters-with-held-runtime-validated-candidates", "non-JS tooling adapter status is incomplete");
assert(matrix.decisionCriteria.productValue.length >= 3, "product value criteria incomplete");
assert(matrix.decisionCriteria.maintenanceCost.length >= 4, "maintenance cost criteria incomplete");
assert(matrix.decisionCriteria.runtimeFit.includes("no direct TCP"), "runtime fit must reject direct TCP");
assert(artifactManifest.schemaVersion === 1, "unexpected non-JS runtime artifact manifest schema");
const artifacts = new Map(artifactManifest.artifacts.map((artifact) => [artifact.id, artifact]));
for (const id of ["python-wasi-webc", "wasmer-sdk-runtime", "wasm-git-memfs", "wasm-git-opfs"]) {
  const artifact = artifacts.get(id);
  assert(/^[a-f0-9]{64}$/.test(artifact?.sha256 || ""), `artifact provenance hash missing: ${id}`);
  assert(artifact?.bytes > 0, `artifact provenance size missing: ${id}`);
  assert(artifact?.source, `artifact provenance source missing: ${id}`);
}

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
assert(fs.readFileSync("tests/system/browser/fixtures/sqlite-opfs-worker.mjs", "utf8").includes("projectId"), "sqlite worker must enforce a project namespace");
assert(candidates.get("python-wasi")?.status === "hold", "python must stay hold until support surface is proven");
assert(candidates.get("git-wasm")?.status === "hold", "git must stay hold until credential/network/storage phase exists");
for (const id of ["python-wasi", "git-wasm"]) {
  const candidate = candidates.get(id);
  assert(/^[a-f0-9]{64}$/.test(candidate.artifact?.sha256 || ""), `${id} runtime artifact hash missing`);
  assert(candidate.artifact?.bytes > 0, `${id} runtime artifact size missing`);
  assert(candidate.filesystem?.adapterResult === "pass", `${id} adapter filesystem boundary missing`);
  assert(candidate.filesystem?.runtimeResult.includes("pass"), `${id} runtime filesystem evidence missing`);
  assert(candidate.syscalls?.expected.length >= 5, `${id} expected syscall surface is incomplete`);
  assert(candidate.syscalls?.denied.some((entry) => entry.includes("socket")), `${id} denied syscall surface must include sockets`);
  assert(candidate.syscalls?.result.includes("behavioral-pass"), `${id} syscall behavioral evidence missing`);
  assert(candidate.credentialsAndNetwork?.directTcp === "deny", `${id} must deny direct TCP`);
  assert(candidate.credentialsAndNetwork?.runtimeResult.includes("pass"), `${id} runtime network evidence missing`);
  assert(candidate.performance?.runtimeResult.includes("pass"), `${id} runtime performance evidence missing`);
  assert(candidate.productSurface?.status === "candidate-contract-only", `${id} must not be product-supported`);
  assert(candidate.requiredBeforeSupport.length >= 3, `${id} promotion blockers are incomplete`);
  assert(candidate.candidateArtifacts.length >= 2, `${id} artifact alternatives were not evaluated`);
  for (const artifact of candidate.candidateArtifacts) {
    assert(artifact.versionObserved, `${id} candidate artifact version missing`);
    assert(artifact.registryIntegrity?.startsWith("sha512-"), `${id} registry integrity missing`);
    assert(artifact.decision, `${id} artifact decision missing`);
  }
  for (const fixture of candidate.fixtures || []) assert(fs.existsSync(fixture), `candidate fixture missing: ${fixture}`);
  assert(!matrix.supportedAdapters.includes(id), `${id} must not appear in supported adapters`);
  assert(!matrix.firstSupportLane.includes(id), `${id} must not appear in the first support lane`);
}
const runtimeExports = fs.readFileSync("packages/node-runtime/src/index.ts", "utf8");
assert(runtimeExports.includes("createPythonWasiProjectAdapter"), "Python candidate adapter must be exported");
assert(runtimeExports.includes("createGitWasmProjectAdapter"), "Git candidate adapter must be exported");
assert(runtimeExports.includes("createIntegrityPinnedWasmerPythonRuntime"), "integrity-pinned Python runtime must be exported");
assert(runtimeExports.includes("createIntegrityPinnedWasmGitRuntime"), "integrity-pinned Git runtime must be exported");
assert(runtimeExports.includes("createGitHostTransportBoundary"), "host-mediated Git transport boundary must be exported");
const browserExports = fs.readFileSync("packages/browser-host/src/index.ts", "utf8");
assert(browserExports.includes("createGitOpfsProjectClient"), "Git OPFS project client must be exported");
assert(candidates.get("python-wasi")?.performance.runtimeResult.includes("memory-unenforced"), "Python must retain the memory enforcement blocker");
assert(candidates.get("python-wasi")?.filesystem.runtimeResult === "node-and-chrome-worker-pass", "Python Chrome Worker evidence is missing");
assert(candidates.get("python-wasi")?.performance.staticAdmissionResult.includes("pass"), "Python static-memory admission evidence is missing");
assert(candidates.get("git-wasm")?.performance.runtimeResult.includes("actual-pack-application-not-run"), "Git must retain the actual pack application blocker");
assert(candidates.get("git-wasm")?.credentialsAndNetwork.hostTransportContract.includes("redacted"), "Git host transport must require redaction");
assert(candidates.get("git-wasm")?.filesystem.runtimeResult.includes("chrome-opfs-reopen-pass"), "Git OPFS reopen evidence is missing");
const gitCandidate = candidates.get("git-wasm");
assert(JSON.parse(fs.readFileSync("node_modules/wasm-git/package.json", "utf8")).version === "0.0.17", "Git WASM package version drifted");
assert(sha256("node_modules/wasm-git/lg2.wasm") === gitCandidate.artifact.sha256, "Git WASM artifact hash drifted");
assert(sha256("node_modules/wasm-git/lg2.js") === gitCandidate.artifact.loaderSha256, "Git WASM loader hash drifted");
assert(sha256("node_modules/wasm-git/lg2_opfs.wasm") === gitCandidate.artifact.opfsSha256, "Git OPFS WASM artifact hash drifted");
assert(sha256("node_modules/wasm-git/lg2_opfs.js") === gitCandidate.artifact.opfsLoaderSha256, "Git OPFS loader hash drifted");
assert(artifacts.get("wasm-git-memfs").sha256 === gitCandidate.artifact.sha256, "Git manifest hash drifted");
assert(artifacts.get("wasm-git-opfs").sha256 === gitCandidate.artifact.opfsSha256, "Git OPFS manifest hash drifted");
const pythonCandidate = candidates.get("python-wasi");
assert(JSON.parse(fs.readFileSync("node_modules/@wasmer/sdk/package.json", "utf8")).version === "0.18.0", "Wasmer SDK version drifted");
assert(sha256("node_modules/@wasmer/sdk/pkg/wasmer_sdk_js_bg.wasm") === pythonCandidate.artifact.sdkWasmSha256, "Wasmer SDK WASM hash drifted");
assert(artifacts.get("python-wasi-webc").sha256 === pythonCandidate.artifact.sha256, "Python manifest hash drifted");
assert(artifacts.get("wasmer-sdk-runtime").sha256 === pythonCandidate.artifact.sdkWasmSha256, "Wasmer SDK manifest hash drifted");
assert(candidates.get("docker-linux-binary")?.status === "unsupported", "docker must remain unsupported");
assert(matrix.excludedByDefault.includes("arbitrary-linux-binary"), "arbitrary Linux binaries must be excluded by default");

console.log("non-JS tooling candidates ok");

function sha256(path) {
  return crypto.createHash("sha256").update(fs.readFileSync(path)).digest("hex");
}
