import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";

type Waiver = { ecosystem: string; id: string; package: string; version: string; kind: string; reason: string;
  owner: string; expiresAt: string; replacement: string };
const policy = JSON.parse(fs.readFileSync("security/dependency-policy.json", "utf8")) as {
  schemaVersion: number; taskId: string; severityGate: string; unresolvedCriticalAllowed: number;
  unresolvedHighAllowed: number; lockfiles: string[]; allowedSources: string[]; allowedLicenseExpressions: string[];
  requiredCommands: string[]; waiverRegistry: string; sbomContract: string };
const registry = JSON.parse(fs.readFileSync(policy.waiverRegistry, "utf8")) as { schemaVersion: number; waivers: Waiver[] };

assert.equal(policy.schemaVersion, 1);
assert.equal(policy.taskId, "SEC-002");
assert.equal(policy.severityGate, "high");
assert.equal(policy.unresolvedCriticalAllowed, 0);
assert.equal(policy.unresolvedHighAllowed, 0);
assert.deepEqual(policy.lockfiles, ["Cargo.lock", "pnpm-lock.yaml"]);
assert.ok(policy.allowedLicenseExpressions.includes("Apache-2.0"));
assert.ok(policy.allowedSources.includes("checked-in-vendor"));
for (const file of [...policy.lockfiles, policy.sbomContract, policy.waiverRegistry, "deny.toml"])
  assert.ok(fs.existsSync(file), `dependency policy input missing: ${file}`);

const evaluationDate = new Date(`${process.env.NURITEO_POLICY_DATE ?? new Date().toISOString().slice(0, 10)}T00:00:00Z`);
assert.equal(registry.schemaVersion, 1);
assert.equal(new Set(registry.waivers.map(({ ecosystem, id }) => `${ecosystem}:${id}`)).size, registry.waivers.length);
for (const waiver of registry.waivers) {
  assert.ok(["cargo", "npm"].includes(waiver.ecosystem));
  assert.ok(waiver.reason.length >= 80, `${waiver.id}: waiver reason is incomplete`);
  assert.ok(waiver.owner.length >= 5 && waiver.replacement.length >= 20);
  const expiry = new Date(`${waiver.expiresAt}T00:00:00Z`);
  assert.ok(Number.isFinite(expiry.valueOf()) && expiry > evaluationDate, `${waiver.id}: waiver expired`);
  assert.ok(expiry.valueOf() - evaluationDate.valueOf() <= 92 * 86_400_000, `${waiver.id}: waiver exceeds 92 days`);
}

const audit = spawnSync("cargo", ["audit", "--no-fetch", "--json"], { encoding: "utf8" });
assert.equal(audit.status, 0, audit.stderr || audit.stdout);
const report = JSON.parse(audit.stdout) as {
  vulnerabilities: { count: number; list: Array<{ advisory: { id: string } }> };
  warnings: Record<string, Array<{ advisory: { id: string }; package: { name: string; version: string } }>>;
};
assert.equal(report.vulnerabilities.count, 0, "Rust vulnerability gate failed");
const activeWaivers = new Map(registry.waivers.map((waiver) => [`${waiver.ecosystem}:${waiver.id}`, waiver]));
for (const [kind, warnings] of Object.entries(report.warnings)) {
  for (const warning of warnings) {
    const waiver = activeWaivers.get(`cargo:${warning.advisory.id}`);
    assert.ok(waiver, `unwaived Cargo ${kind}: ${warning.advisory.id}`);
    assert.equal(waiver.package, warning.package.name);
    assert.equal(waiver.version, warning.package.version);
    assert.equal(waiver.kind, kind);
  }
}

const inventory = JSON.parse(fs.readFileSync(policy.sbomContract, "utf8")) as {
  bundles: Array<{ artifacts: Array<{ kind: string; sbomRefs?: string[] }> }> };
const releaseArtifacts = inventory.bundles.flatMap(({ artifacts }) => artifacts);
assert.ok(releaseArtifacts.some(({ kind }) => kind === "sbom"), "release inventory has no SBOM");
assert.ok(releaseArtifacts.filter(({ kind }) => kind === "oci-image").every(({ sbomRefs }) => (sbomRefs?.length ?? 0) > 0),
  "every OCI release artifact must reference an SBOM");

console.log(JSON.stringify({ status: "pass", task: policy.taskId, rustDependencies: report.vulnerabilities.count,
  waivers: registry.waivers.length, licenses: policy.allowedLicenseExpressions.length }));
