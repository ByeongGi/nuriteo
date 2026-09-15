import fs from "node:fs";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const matrix = JSON.parse(fs.readFileSync("compat/non-js-tooling-candidates.json", "utf8"));
const document = fs.readFileSync("docs/productization/non-js-tooling-candidates.md", "utf8");

assert(matrix.schemaVersion === 1, "unexpected non-JS tooling schema");
assert(matrix.decisionCriteria.productValue.length >= 3, "product value criteria incomplete");
assert(matrix.decisionCriteria.maintenanceCost.length >= 4, "maintenance cost criteria incomplete");
assert(matrix.decisionCriteria.runtimeFit.includes("no direct TCP"), "runtime fit must reject direct TCP");

const candidates = new Map(matrix.candidates.map((candidate) => [candidate.id, candidate]));
for (const id of ["jq-wasm", "sqlite-wasm", "python-wasi", "git-wasm", "docker-linux-binary"]) {
  assert(candidates.has(id), `missing non-JS tooling candidate: ${id}`);
  assert(document.includes(id), `candidate document missing ${id}`);
}
for (const id of matrix.firstSupportLane) {
  assert(candidates.get(id)?.status === "candidate", `first support lane must contain only candidates: ${id}`);
}
assert(candidates.get("python-wasi")?.status === "hold", "python must stay hold until support surface is proven");
assert(candidates.get("git-wasm")?.status === "hold", "git must stay hold until credential/network/storage phase exists");
assert(candidates.get("docker-linux-binary")?.status === "unsupported", "docker must remain unsupported");
assert(matrix.excludedByDefault.includes("arbitrary-linux-binary"), "arbitrary Linux binaries must be excluded by default");

console.log("non-JS tooling candidates ok");
