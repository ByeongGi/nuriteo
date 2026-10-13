import assert from "node:assert/strict";
import fs from "node:fs";

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const decision = readJson("compat/launch-decision.json");
const reliability = readJson("compat/runtime-reliability-policy.json");
const actualFixtures = readJson("compat/ecosystem-fixture-actual-product-results.json");
const serviceFixtures = readJson("compat/service-workflow-fixture-results.json");
const browserSmoke = readJson("compat/browser-smoke-results.json");

const heldFixtureIds = new Set(reliability.holdFixtures.map((fixture) => fixture.id));
const measuredHeldFixtureIds = actualFixtures.results.filter((result) => result.status === "hold").map((result) => result.id);
assert.deepEqual([...heldFixtureIds].sort(), measuredHeldFixtureIds.sort(), "public fixture holds must match canonical measurements");

for (const id of heldFixtureIds) {
  const actual = actualFixtures.results.find((result) => result.id === id);
  const service = serviceFixtures.results.find((result) => result.id === id);
  assert.ok(actual, `held fixture ${id} is missing actual-product evidence`);
  assert.equal(actual.status, "hold", `held fixture ${id} actual-product status drifted`);
  assert.ok(actual.criteria.some((criterion) => criterion.status === "fail"), `held fixture ${id} has no recorded failure`);
  assert.equal(service?.status, "hold", `held fixture ${id} must remain hold in the service matrix`);
}

const browserHolds = Object.entries(reliability.browserGrades)
  .filter(([, grade]) => grade === "hold")
  .map(([browser]) => browser);
const publicCohortBrowserHold = decision.supportMatrix.publicFixtureBrowserWorker !== "supported";
const unresolved = heldFixtureIds.size > 0 || browserHolds.length > 0 || publicCohortBrowserHold;

assert.equal(browserSmoke.results.edge.status, "pass", "supported Edge grade requires passing smoke evidence");
assert.equal(browserSmoke.results.safari.status, "pass", "supported Safari grade requires passing smoke evidence");

if (unresolved) {
  assert.notEqual(decision.decision, "public-beta-ready", "unresolved fixture/browser holds forbid public-beta-ready");
  assert.equal(decision.milestones["S-C"]?.status, "hold", "unresolved public-beta blockers require S-C hold");
  assert.ok(decision.launchBlockersForPublicBeta?.length > 0, "public-beta blockers must be listed");
}

assert.deepEqual(
  decision.supportMatrix.safari,
  reliability.browserGrades.safari,
  "launch decision and reliability policy disagree on Safari"
);
assert.deepEqual(
  decision.supportMatrix.edge,
  reliability.browserGrades.edge,
  "launch decision and reliability policy disagree on Edge"
);

console.log(
  `public beta readiness ok decision=${decision.decision} heldFixtures=${heldFixtureIds.size} browserHolds=${browserHolds.join(",") || "none"} publicCohortBrowserHold=${publicCohortBrowserHold}`
);
