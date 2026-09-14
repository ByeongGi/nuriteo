import fs from "node:fs";

const versions = JSON.parse(fs.readFileSync("compat/versions.json", "utf8"));
const baseline = versions.runtimeBaseline.node.version;
const rehearsal = versions.runtimeBaseline.node.rehearsalCandidate;

if (!rehearsal) {
  throw new Error("runtimeBaseline.node.rehearsalCandidate is required");
}
if (rehearsal.version === baseline) {
  throw new Error("rehearsal candidate must differ from baseline");
}
if (!rehearsal.darwinArm64Tarball?.sha256 || !rehearsal.linuxX64Tarball?.sha256) {
  throw new Error("rehearsal candidate must pin release artifact hashes");
}
if (rehearsal.status !== "rehearsed-not-promoted") {
  throw new Error(`unexpected rehearsal status: ${rehearsal.status}`);
}

console.log(`node upgrade rehearsal manifest ok: ${baseline} -> ${rehearsal.version}`);
