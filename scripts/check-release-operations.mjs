import fs from "node:fs";
import path from "node:path";

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const checklist = readJson("compat/release-checklist.json");
const progress = fs.readFileSync("docs/productization/PROGRESS.md", "utf8");
const document = fs.readFileSync("docs/release/release-checklist.md", "utf8");

assert(checklist.schemaVersion === 1, "unexpected release checklist schema");
assert(checklist.releaseDecision === "internal-release-operations-ready", "release decision must be internal operations ready");
assert(checklist.externalPublish === "not-in-scope-until-PG20", "external publish decision must be explicit");
assert(checklist.gateReview.PG15 === "pass", "PG15 must be pass for P16 acceptance");
assert(checklist.gateReview.PG16 === "pass", "PG16 must be pass for P16 acceptance");
assert(checklist.gateReview.stableLaunch === "blocked-until-PG20", "stable launch must remain blocked until PG20");

for (const file of [...checklist.requiredDocs, ...checklist.requiredManifests]) {
  assert(fs.existsSync(path.resolve(file)), `missing release operations artifact: ${file}`);
}
for (const command of checklist.requiredChecks) {
  assert(document.includes(command), `release checklist missing command: ${command}`);
}
for (const item of checklist.acceptance) {
  assert(item.length > 20, `release checklist acceptance item is too weak: ${item}`);
}
assert(progress.includes("| P15 | [관측성·성능](./phases/P15-observability-performance.md) | PG14 | 4/4 | PG15: PASS | DONE |"), "P15 must be complete before PG16");
assert(progress.includes("| P16 | [릴리스 운영](./phases/P16-release-operations.md) | PG15 | 4/4 | PG16: PASS | DONE |"), "P16 must be marked done");
assert(document.includes("Stable 외부 publish"), "release checklist must state external publish boundary");

console.log("release operations ok");
