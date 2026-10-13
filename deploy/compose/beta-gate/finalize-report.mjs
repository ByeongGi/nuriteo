#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const required = (name) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
};
const reportFile = required("NURITEO_BETA_GATE_REPORT_FILE");
const stageDirectory = required("NURITEO_BETA_GATE_STAGE_RESULT_DIR");
const contract = JSON.parse(fs.readFileSync(new URL("./contract.json", import.meta.url), "utf8"));
const stages = {};
const evidenceItems = [];
for (const stage of contract.requiredStages) {
  const result = JSON.parse(fs.readFileSync(path.join(stageDirectory, `${stage}.json`), "utf8"));
  if (result.stage !== stage || result.status !== "PASS") throw new Error(`${stage} result is invalid`);
  stages[stage] = { status: result.status, evidence: result.evidence, sha256: result.sha256 };
  evidenceItems.push(JSON.parse(fs.readFileSync(path.join(path.dirname(reportFile), result.evidence), "utf8")));
}
const composeProject = required("NURITEO_BETA_GATE_COMPOSE_PROJECT");
const databaseLineage = required("NURITEO_BETA_GATE_DATABASE_LINEAGE");
const objectLineage = required("NURITEO_BETA_GATE_OBJECT_LINEAGE");
const allEvidencePasses = evidenceItems.every((item) => item.status === "PASS");
const sameComposeProject = evidenceItems.every((item) => item.composeProject === composeProject);
const sameDatabaseLineage = evidenceItems.every((item) =>
  item.databaseLineage === databaseLineage && item.objectLineage === objectLineage
);
const cleanInstall = stages["clean-install"]?.status === "PASS";
const secretScanPassed = stages["secret-scan"]?.status === "PASS";
if (!allEvidencePasses || !sameComposeProject || !sameDatabaseLineage || !cleanInstall || !secretScanPassed) {
  throw new Error("aggregate attestation cannot be derived from stage evidence");
}
const report = {
  schemaVersion: 1, gate: "GATE-005", verdict: allEvidencePasses ? "self-hosted-beta-ready" : "blocked",
  cleanInstall, sameComposeProject, sameDatabaseLineage, secretsFound: !secretScanPassed,
  run: {
    composeProject, databaseLineage, objectLineage,
    containerIds: JSON.parse(fs.readFileSync(required("NURITEO_BETA_GATE_CONTAINER_LEDGER"), "utf8"))
  },
  releaseLineage: {
    alphaBaselineCommit: contract.alphaBaselineCommit,
    releaseCommit: required("NURITEO_BETA_GATE_RELEASE_COMMIT"), workingTreeClean: true,
    images: JSON.parse(fs.readFileSync(required("NURITEO_BETA_GATE_IMAGE_LEDGER"), "utf8"))
  },
  stages
};
fs.writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
