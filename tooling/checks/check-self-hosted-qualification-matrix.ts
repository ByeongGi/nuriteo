import assert from "node:assert/strict";
import fs from "node:fs";

type Entry = {
  id: string;
  area: string;
  environment: string;
  mode: string;
  status: string;
  artifact: string;
  checks: string[];
};
const matrix = JSON.parse(fs.readFileSync("compat/self-hosted-v1-qualification-matrix.json", "utf8")) as {
  schemaVersion: number;
  taskId: string;
  status: string;
  entries: Entry[];
  excluded: string[];
};
const support = JSON.parse(fs.readFileSync("compat/self-hosted-v1-support-matrix.json", "utf8")) as {
  support: Array<{ id: string; status: string; contract: string; evidence: string[] }>;
};
const browser = JSON.parse(fs.readFileSync("compat/browser-smoke-results.json", "utf8")) as {
  results: Record<string, { status: string; version?: string }>;
};
const documentation = fs.readFileSync("docs/release/self-hosted-v1-qualification-matrix.md", "utf8");

assert.equal(matrix.schemaVersion, 1);
assert.equal(matrix.taskId, "QUAL-001");
assert.equal(matrix.status, "pass");
const required = [
  "postgresql-17", "postgresql-18", "s3-compatible", "kubernetes-1.29",
  "kubernetes-1.37", "chrome-desktop", "edge-desktop", "safari-desktop"
];
assert.deepEqual(matrix.entries.map(({ id }) => id), required);
for (const entry of matrix.entries) {
  assert.equal(entry.mode, "actual", `${entry.id}: qualification must be actual`);
  assert.equal(entry.status, "pass", `${entry.id}: required environment did not pass`);
  assert.ok(entry.environment.length >= 20, `${entry.id}: environment is incomplete`);
  assert.ok(entry.artifact.length >= 10, `${entry.id}: artifact identity is incomplete`);
  assert.ok(entry.checks.length >= 5, `${entry.id}: coverage is incomplete`);
  assert.ok(documentation.includes(`| \`${entry.id}\` |`), `${entry.id}: documentation row missing`);
}
assert.equal(new Set(required).size, matrix.entries.length);
assert.equal(matrix.excluded.length, 3);

for (const id of ["SHV1-KUBERNETES", "SHV1-POSTGRESQL", "SHV1-BROWSER-EDGE", "SHV1-BROWSER-SAFARI"]) {
  const entry = support.support.find((candidate) => candidate.id === id);
  assert.equal(entry?.status, "qualified", `${id}: support matrix was not promoted`);
  assert.ok(entry.evidence.includes("compat/self-hosted-v1-qualification-matrix.json"), `${id}: qualification evidence missing`);
}
assert.equal(browser.results.chrome.status, "pass");
assert.equal(browser.results.chrome.version, "154.0.8037.98");
assert.equal(browser.results.edge.status, "pass");
assert.equal(browser.results.edge.version, "155.0.4283.45");
assert.equal(browser.results.safari.status, "pass");
assert.equal(browser.results.safari.version, "26.6.2");

console.log(JSON.stringify({ status: "pass", task: matrix.taskId, actualEnvironments: matrix.entries.length }));
