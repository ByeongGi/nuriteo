import fs from "node:fs";
import crypto from "node:crypto";

const gate = JSON.parse(fs.readFileSync("compat/yarn-v1-product-support.json", "utf8"));
assert(gate.schemaVersion === 1, "unexpected Yarn support schema");
assert(gate.status === "supported" && gate.publicGrade === "supported", "Yarn product support grade must match passing gates");
assert(gate.artifact.entrySha256.length === 64 && gate.artifact.bundleSha256.length === 64, "Yarn artifact hashes are missing");

const capabilities = new Map(gate.capabilities.map((entry) => [entry.id, entry]));
for (const id of ["vendored-real-cli", "real-cli-bundle-graph", "real-cli-version", "local-file-install", "scripts-and-exec", "cancellation-recovery-soak", "registry-resolution-install", "real-cli-browser-execution", "detection-override-ui"]) {
  assert(capabilities.get(id)?.status === "pass", `Yarn capability must pass: ${id}`);
}
for (const id of gate.promotionGate.requires) {
  const capability = capabilities.get(id);
  assert(capability?.status === "pass", `Yarn promotion capability must pass: ${id}`);
}
assert(gate.promotionGate.status === "passed", "Yarn promotion gate must pass");
assert(gate.failureTaxonomy?.YARN_REGISTRY_DECOMPRESSION_STREAM_ORDERING?.status === "resolved", "Yarn registry stream regression must remain tracked");
for (const capability of gate.capabilities) {
  for (const evidence of capability.evidence || []) assert(fs.existsSync(evidence), `missing Yarn evidence: ${evidence}`);
}
const shell = fs.readFileSync("packages/workspace-runtime/src/shell.ts", "utf8");
assert(shell.includes('yarn: (context) => runPackageManager'), "preview shell must route Yarn commands");
const factory = fs.readFileSync(gate.artifact.cspFactory);
assert(crypto.createHash("sha256").update(factory).digest("hex") === gate.artifact.cspFactorySha256,
  "Yarn CSP factory must match the pinned production asset");

console.log(`yarn v1 product support gate ok status=${gate.status}`);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
