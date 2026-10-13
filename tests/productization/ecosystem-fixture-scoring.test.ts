import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const result = spawnSync(process.execPath, [
  new URL("../../tooling/fixtures/score-ecosystem-fixtures.ts", import.meta.url).pathname,
  "--plan",
  "--fixtures=vite-official-template-react,hvalette-react-vite-template"
], {
  encoding: "utf8"
});

assert.equal(result.status, 0, result.stderr);
const payload = JSON.parse(result.stdout);
assert.equal(payload.schemaVersion, 1);
assert.equal(payload.source, "compat/ecosystem-fixtures.json");
assert.equal(payload.minimumPassForMilestoneB, 7);
assert.equal(payload.results.length, 2);
assert.deepEqual(payload.results.map((entry) => entry.id), [
  "vite-official-template-react",
  "hvalette-react-vite-template"
]);
assert.match(payload.results[0].revision, /^[0-9a-f]{40}$/);
assert.equal(payload.results[0].revision, payload.inputContract.fixtureRevisions["vite-official-template-react"]);
assert.ok(payload.results.every((entry) => entry.mode === "plan"));
assert.ok(payload.results.every((entry) => entry.criteria.length === 4));
assert.equal(payload.summary.milestoneB, "not-yet");

console.log("ecosystem fixture scoring test ok");
