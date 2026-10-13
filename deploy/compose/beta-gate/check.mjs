import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(directory, "../../..");
const contract = readJson(path.join(directory, "contract.json"));
const command = process.argv[2] ?? "readiness";

if (command === "readiness") {
  const allowBlocked = process.argv.includes("--allow-blocked");
  const result = inspectReadiness();
  for (const line of result.lines) console.log(line);
  if (!result.ready && !allowBlocked) process.exitCode = 3;
} else if (command === "report") {
  const reportPath = process.argv[3];
  const expectedCommit = process.argv[4];
  if (!reportPath || !expectedCommit) fail("usage: check.mjs report <report.json> <release-commit>");
  validateReport(readJson(path.resolve(reportPath)), expectedCommit, path.resolve(reportPath));
  console.log(`GATE-005 report contract ok (${expectedCommit})`);
} else if (command === "self-test-report") {
  const reportPath = process.argv[3];
  const expectedCommit = process.argv[4];
  if (!reportPath || !expectedCommit) fail("usage: check.mjs self-test-report <report.json> <release-commit>");
  validateReport(readJson(path.resolve(reportPath)), expectedCommit, path.resolve(reportPath), false);
  console.log(`GATE-005 report contract self-test ok (${expectedCommit})`);
} else {
  fail("usage: check.mjs {readiness [--allow-blocked]|report|self-test-report <report.json> <release-commit>}");
}

function inspectReadiness() {
  const graphPath = path.join(repositoryRoot, contract.taskGraph);
  const graph = readJson(graphPath);
  const gate = graph.nodes?.find((node) => node.id === contract.gate);
  if (!gate || !Array.isArray(gate.dependsOn)) fail(`${contract.gate} is absent from the task graph`);
  const duplicateDependencies = gate.dependsOn.filter(
    (value, index, values) => values.indexOf(value) !== index
  );
  if (duplicateDependencies.length > 0) fail(`${contract.gate} has duplicate dependencies`);

  const blockers = [];
  for (const taskId of gate.dependsOn) {
    const evidencePath = path.join(
      repositoryRoot,
      "docs/implementation/self-hosted/evidence",
      `${taskId}.md`
    );
    if (!fs.existsSync(evidencePath)) {
      blockers.push(`${taskId}: evidence missing`);
      continue;
    }
    const evidence = fs.readFileSync(evidencePath, "utf8");
    const status = evidence.match(/^- (?:상태|판정): `([^`]+)`/mu)?.[1];
    if (status !== "DONE" && status !== "PASS") {
      blockers.push(`${taskId}: evidence status is ${status ?? "missing"}`);
    }
  }

  const lines = [
    `${contract.gate} dependency evidence: ${gate.dependsOn.length - blockers.length}/${gate.dependsOn.length} ready`
  ];
  for (const blocker of blockers) lines.push(`BLOCKED ${blocker}`);
  if (blockers.length === 0) lines.push(`${contract.gate} aggregate may start`);
  return { ready: blockers.length === 0, lines };
}

function validateReport(report, expectedCommit, reportPath, verifyRepository = true) {
  if (verifyRepository) {
    assert(currentRepositoryCommit() === expectedCommit, "checked-out commit changed during report validation");
    assert(repositoryIsClean(), "working tree is not clean during report validation");
  }
  assert(!containsSecret(JSON.stringify(report)), "report contains protected material");
  assert(report.schemaVersion === contract.schemaVersion, "unsupported report schemaVersion");
  assert(report.gate === contract.gate, "report gate does not match GATE-005");
  assert(report.verdict === "self-hosted-beta-ready", "report verdict is not self-hosted-beta-ready");
  assert(report.cleanInstall === true, "report did not use a clean install");
  assert(report.sameComposeProject === true, "journey did not stay in one Compose project");
  assert(report.sameDatabaseLineage === true, "journey did not preserve one database lineage");
  assert(report.secretsFound === false, "secret scan did not pass");

  const run = report.run;
  assert(run && typeof run === "object", "run identity is missing");
  assert(/^[a-z0-9][a-z0-9_-]{2,62}$/u.test(run.composeProject ?? ""), "Compose project identity is invalid");
  assert(/^[0-9a-f-]{36}$/u.test(run.databaseLineage ?? ""), "database lineage identity is invalid");
  assert(/^[0-9a-f-]{36}$/u.test(run.objectLineage ?? ""), "object lineage identity is invalid");
  assert(Array.isArray(run.containerIds) && run.containerIds.length >= 3, "container identity ledger is missing");
  assert(new Set(run.containerIds).size === run.containerIds.length, "container identity ledger has duplicates");
  for (const id of run.containerIds) assert(/^[0-9a-f]{12,64}$/u.test(id), "container identity is invalid");

  const lineage = report.releaseLineage;
  assert(lineage && typeof lineage === "object", "releaseLineage is missing");
  assert(lineage.alphaBaselineCommit === contract.alphaBaselineCommit, "Alpha baseline commit drifted");
  assert(lineage.releaseCommit === expectedCommit, "report release commit does not match checked commit");
  assert(lineage.workingTreeClean === true, "report was not produced from a clean tree");

  assert(Array.isArray(lineage.images), "release image lineage is missing");
  for (const name of contract.requiredImages) {
    const image = lineage.images.find((candidate) => candidate?.name === name);
    assert(image, `release image ${name} is missing`);
    assert(image.sourceCommit === expectedCommit, `${name} image source commit does not match`);
    assert(image.sourceCommitLabelVerified === true, `${name} image revision label was not verified`);
    assert(/^sha256:[0-9a-f]{64}$/u.test(image.digest ?? ""), `${name} image digest is invalid`);
  }

  const stages = report.stages;
  assert(stages && typeof stages === "object" && !Array.isArray(stages), "stages are missing");
  for (const stageName of contract.requiredStages) {
    const stage = stages[stageName];
    assert(stage?.status === "PASS", `${stageName} did not pass`);
    assert(typeof stage.evidence === "string" && stage.evidence.length > 0, `${stageName} evidence is missing`);
    assert(/^evidence\/[a-z0-9-]+\.json$/u.test(stage.evidence), `${stageName} evidence path is not canonical`);
    assert(/^sha256:[0-9a-f]{64}$/u.test(stage.sha256 ?? ""), `${stageName} evidence digest is invalid`);
    validateEvidence(stageName, stage, report, reportPath);
  }
  assert(Object.keys(stages).length === contract.requiredStages.length, "report contains undeclared stages");
}

function currentRepositoryCommit() {
  return runGit(["rev-parse", "HEAD"]).trim();
}

function repositoryIsClean() {
  return runGit(["status", "--porcelain=v1", "--untracked-files=all"]).trim() === "";
}

function runGit(args) {
  const result = spawnSync("git", ["-C", repositoryRoot, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (result.status !== 0) fail("cannot verify repository state");
  return result.stdout;
}

function validateEvidence(stageName, stage, report, reportPath) {
  const reportDirectory = path.dirname(reportPath);
  const evidencePath = path.resolve(reportDirectory, stage.evidence);
  const relative = path.relative(reportDirectory, evidencePath);
  assert(relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative), `${stageName} evidence escapes report directory`);
  const stat = safeStat(evidencePath, `${stageName} evidence is missing`);
  assert(stat.isFile() && !stat.isSymbolicLink(), `${stageName} evidence must be a regular file`);
  const realReportDirectory = fs.realpathSync(reportDirectory);
  const realEvidencePath = fs.realpathSync(evidencePath);
  const realRelative = path.relative(realReportDirectory, realEvidencePath);
  assert(realRelative !== "" && !realRelative.startsWith("..") && !path.isAbsolute(realRelative), `${stageName} evidence resolves outside report directory`);
  const bytes = fs.readFileSync(evidencePath);
  const digest = `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`;
  assert(digest === stage.sha256, `${stageName} evidence digest does not match`);
  const evidence = parseJsonBytes(bytes, evidencePath);
  assert(evidence.schemaVersion === contract.schemaVersion, `${stageName} evidence schemaVersion drifted`);
  assert(evidence.gate === contract.gate && evidence.stage === stageName, `${stageName} evidence identity drifted`);
  assert(evidence.status === "PASS", `${stageName} evidence did not pass`);
  assert(evidence.releaseCommit === report.releaseLineage.releaseCommit, `${stageName} evidence release commit drifted`);
  assert(evidence.composeProject === report.run.composeProject, `${stageName} evidence Compose project drifted`);
  assert(evidence.databaseLineage === report.run.databaseLineage, `${stageName} evidence database lineage drifted`);
  assert(evidence.objectLineage === report.run.objectLineage, `${stageName} evidence object lineage drifted`);
  assert(Array.isArray(evidence.assertions) && evidence.assertions.length > 0, `${stageName} has no actual assertions`);
  for (const assertion of evidence.assertions) {
    assert(assertion && assertion.status === "PASS", `${stageName} contains a failed assertion`);
    assert(typeof assertion.name === "string" && assertion.name.length > 0, `${stageName} assertion name is missing`);
    assert(["api", "browser", "container", "database", "object", "process", "source"].includes(assertion.kind), `${stageName} assertion kind is invalid`);
  }
  assert(evidence.assertions.some((assertion) => assertion.kind !== "source"), `${stageName} has no runtime assertion`);
  assert(!containsSecret(bytes.toString("utf8")), `${stageName} evidence contains protected material`);
}

function safeStat(filePath, message) {
  try { return fs.lstatSync(filePath); } catch { fail(message); }
}

function parseJsonBytes(bytes, filePath) {
  try { return JSON.parse(bytes.toString("utf8")); }
  catch (error) { fail(`cannot read JSON ${filePath}: ${error instanceof Error ? error.message : "unknown error"}`); }
}

function containsSecret(value) {
  return /(?:nrt_(?:inv|org_inv)_[A-Za-z0-9._-]+|nur_(?:pat|prj)_[A-Za-z0-9._-]+|X-Amz-(?:Credential|Signature)|BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY|(?:password|client_secret|access_token|refresh_token|authorization)\s*[=:]\s*[^\s"']+)/iu.test(value);
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    fail(`cannot read JSON ${filePath}: ${error instanceof Error ? error.message : "unknown error"}`);
  }
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function fail(message) {
  console.error(`GATE-005 contract error: ${message}`);
  process.exit(1);
}
