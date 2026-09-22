import fs from "node:fs";

const gate = JSON.parse(fs.readFileSync("compat/yarn-v1-product-support.json", "utf8"));
assert(gate.schemaVersion === 1, "unexpected Yarn support schema");
assert(gate.status === "hold" && gate.publicGrade === "candidate", "Yarn must not overclaim product support");
assert(gate.artifact.entrySha256.length === 64 && gate.artifact.bundleSha256.length === 64, "Yarn artifact hashes are missing");

const capabilities = new Map(gate.capabilities.map((entry) => [entry.id, entry]));
for (const id of ["vendored-real-cli", "real-cli-bundle-graph", "real-cli-version", "local-file-install", "scripts-and-exec", "cancellation-recovery-soak"]) {
  assert(capabilities.get(id)?.status === "pass", `Yarn capability must pass: ${id}`);
}
for (const id of gate.promotionGate.requires) {
  const capability = capabilities.get(id);
  assert(capability?.status === "hold", `Yarn promotion blocker must remain explicit: ${id}`);
  assert(capability.blocker?.length > 0, `Yarn blocker must explain ${id}`);
}
assert(gate.promotionGate.status === "blocked", "Yarn promotion gate must stay blocked until every required capability passes");
assert(gate.failureTaxonomy?.YARN_REGISTRY_DECOMPRESSION_STREAM_ORDERING?.status === "open", "Yarn registry stream failure taxonomy must remain explicit");
for (const capability of gate.capabilities) {
  for (const evidence of capability.evidence || []) assert(fs.existsSync(evidence), `missing Yarn evidence: ${evidence}`);
}
const shell = fs.readFileSync("packages/preview-service/src/shell.ts", "utf8");
assert(shell.includes("yarn: unsupported"), "preview shell must continue to block Yarn while the promotion gate is blocked");

console.log(`yarn v1 product support gate ok status=${gate.status}`);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
