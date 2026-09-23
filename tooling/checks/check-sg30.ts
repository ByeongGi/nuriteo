import fs from "node:fs";

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const decision = readJson("compat/launch-decision.json");
const allowed = new Set(decision.allowedDecisions || []);
assert(allowed.has("private-beta-ready") && allowed.has("public-beta-ready") && allowed.has("hold"), "allowed decisions incomplete");
assert(allowed.has(decision.decision), `decision must be one of ${[...allowed].join("|")}`);
assert(decision.decision === "private-beta-ready" || decision.decision === "public-beta-ready" || decision.decision === "hold", "invalid decision value");

assert(decision.milestones["S-A"]?.status === "pass", "S-A must pass for any beta decision");
if (decision.decision === "private-beta-ready") {
  assert(decision.milestones["S-B"]?.status === "pass", "private-beta-ready requires S-B pass");
}
if (decision.decision === "public-beta-ready") {
  assert(decision.milestones["S-B"]?.status === "pass", "public-beta-ready requires S-B pass");
  assert(decision.milestones["S-C"]?.status === "pass", "public-beta-ready requires S-C pass");
  assert(decision.gates.SG27 === "pass", "public-beta-ready requires SG27 pass");
  assert(decision.gates.SG29 === "pass", "public-beta-ready requires SG29 pass");
}

for (const gate of ["SG21", "SG22", "SG23", "SG24", "SG25", "SG26", "SG27"]) {
  assert(decision.gates[gate] === "pass", `${gate} must be pass in launch decision`);
}
assert(decision.gates.SG28 === "pass", "SG28 must be pass before SG30 closes");
assert(decision.gates.SG29 === "pass", "SG29 must be pass before SG30 closes");
assert(decision.gates.SG30 === decision.decision, "SG30 gate value must match decision");

assert(Array.isArray(decision.acceptedRisks) && decision.acceptedRisks.length > 0, "accepted risks required");
assert(fs.existsSync("docs/productization/beta-onboarding-guide.md"), "beta onboarding guide missing");
assert(fs.existsSync("docs/productization/browser-support-grades.md"), "browser support grades missing");

const plan = fs.readFileSync("docs/productization/service-readiness-plan.md", "utf8");
assert(plan.includes("SG30"), "service-readiness-plan must mention SG30");
assert(plan.includes(decision.decision), "service-readiness-plan must record launch decision");

console.log(`SG30 ok decision=${decision.decision}`);
