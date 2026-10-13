import assert from "node:assert/strict";
import fs from "node:fs";

type SupportStatus = "supported" | "candidate" | "qualified" | "unsupported";
type SupportEntry = {
  id: string;
  area: string;
  status: SupportStatus;
  contract: string;
  qualification: string;
  evidence: string[];
};
type KnownLimit = { id: string; summary: string };
type SupportMatrix = {
  schemaVersion: number;
  taskId: string;
  releaseLineage: string;
  reviewedAt: string;
  statusDefinitions: Record<SupportStatus, string>;
  support: SupportEntry[];
  knownLimits: KnownLimit[];
};

const matrixPath = "compat/self-hosted-v1-support-matrix.json";
const documentationPath = "docs/release/self-hosted-v1-support-matrix.md";
const matrix = JSON.parse(fs.readFileSync(matrixPath, "utf8")) as SupportMatrix;
const documentation = fs.readFileSync(documentationPath, "utf8");

assert.equal(matrix.schemaVersion, 1);
assert.equal(matrix.taskId, "SUP-001");
assert.equal(matrix.releaseLineage, "nuriteo-self-hosted-v1");
assert.match(matrix.reviewedAt, /^\d{4}-\d{2}-\d{2}$/u);
assert.deepEqual(Object.keys(matrix.statusDefinitions).sort(), ["candidate", "qualified", "supported", "unsupported"]);

const requiredSupportIds = [
  "SHV1-OCI",
  "SHV1-COMPOSE-DOCKER",
  "SHV1-COMPOSE-PODMAN",
  "SHV1-KUBERNETES",
  "SHV1-POSTGRESQL",
  "SHV1-S3",
  "SHV1-BROWSER-CHROME",
  "SHV1-BROWSER-EDGE",
  "SHV1-BROWSER-SAFARI",
  "SHV1-AUTH",
  "SHV1-UPGRADE",
  "SHV1-AIRGAP",
];
const requiredLimitIds = [
  "SHV1-LIMIT-MANAGED",
  "SHV1-LIMIT-SECRET",
  "SHV1-LIMIT-MOBILE",
  "SHV1-LIMIT-RUNTIME",
  "SHV1-LIMIT-REGISTRY",
  "SHV1-LIMIT-S3",
  "SHV1-LIMIT-DOWNGRADE",
  "SHV1-LIMIT-HA",
];

assert.deepEqual(matrix.support.map(({ id }) => id), requiredSupportIds);
assert.deepEqual(matrix.knownLimits.map(({ id }) => id), requiredLimitIds);
assert.equal(new Set([...requiredSupportIds, ...requiredLimitIds]).size, matrix.support.length + matrix.knownLimits.length);

for (const entry of matrix.support) {
  assert.ok(entry.area.length >= 3, `${entry.id}: area is incomplete`);
  assert.ok(entry.contract.length >= 20, `${entry.id}: contract is incomplete`);
  assert.ok(entry.qualification.length >= 30, `${entry.id}: qualification is incomplete`);
  assert.ok(entry.evidence.length >= 1, `${entry.id}: evidence is missing`);
  for (const evidence of entry.evidence) {
    assert.ok(!evidence.startsWith("/") && !evidence.includes(".."), `${entry.id}: unsafe evidence path`);
    assert.ok(fs.existsSync(evidence), `${entry.id}: evidence does not exist: ${evidence}`);
  }
  const row = `| \`${entry.id}\` | ${entry.area} | \`${entry.status}\` | ${entry.contract} | ${entry.qualification} |`;
  assert.ok(documentation.includes(row), `${entry.id}: documentation row drifted`);
}

for (const limit of matrix.knownLimits) {
  assert.ok(limit.summary.length >= 30, `${limit.id}: summary is incomplete`);
  const row = `| \`${limit.id}\` | ${limit.summary} |`;
  assert.ok(documentation.includes(row), `${limit.id}: documentation row drifted`);
}

const imagePolicy = JSON.parse(fs.readFileSync("release/ga/reproducible-images-policy.json", "utf8")) as {
  platforms: string[];
  roles: string[];
};
const oci = matrix.support.find(({ id }) => id === "SHV1-OCI");
assert.ok(oci !== undefined);
for (const platform of imagePolicy.platforms) assert.ok(oci.contract.includes(platform));
for (const role of imagePolicy.roles) assert.ok(oci.contract.toLowerCase().includes(role));

const chart = fs.readFileSync("charts/nuriteo/Chart.yaml", "utf8");
assert.match(chart, /kubeVersion: ">=1\.29\.0-0"/u);
const kubernetes = matrix.support.find(({ id }) => id === "SHV1-KUBERNETES");
assert.ok(kubernetes?.contract.includes("1.29 through 1.37"));

const browsers = JSON.parse(fs.readFileSync("compat/browser-smoke-results.json", "utf8")) as {
  results: { edge: { version: string }; safari: { version: string; platform: string } };
};
assert.ok(matrix.support.find(({ id }) => id === "SHV1-BROWSER-EDGE")?.contract.includes(browsers.results.edge.version.split(".")[0]));
assert.ok(matrix.support.find(({ id }) => id === "SHV1-BROWSER-SAFARI")?.contract.includes(browsers.results.safari.version));

const compatibility = JSON.parse(fs.readFileSync("compat/self-hosted-upgrade-compatibility-v1.json", "utf8")) as {
  support: { direction: string; downgrade: string };
};
assert.equal(compatibility.support.direction, "forward-only");
assert.equal(compatibility.support.downgrade, "not-supported");

const oldSupportDocument = fs.readFileSync("docs/release/support-matrix.md", "utf8");
const knownLimitations = fs.readFileSync("docs/release/known-limitations.md", "utf8");
assert.ok(oldSupportDocument.includes("self-hosted-v1-support-matrix.md"));
assert.ok(knownLimitations.includes("self-hosted-v1-support-matrix.md"));
assert.ok(!knownLimitations.includes("Identity-provider integration, enforced team/org ACL"));
assert.ok(!knownLimitations.includes("built-in persistence path is local-first memory/JSON"));

console.log(JSON.stringify({
  status: "pass",
  task: matrix.taskId,
  supportEntries: matrix.support.length,
  knownLimits: matrix.knownLimits.length,
  candidates: matrix.support.filter(({ status }) => status === "candidate").length,
}));
