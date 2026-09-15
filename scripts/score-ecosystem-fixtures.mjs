#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = new URL("..", import.meta.url).pathname;
const matrixPath = path.join(root, "compat/ecosystem-fixtures.json");
const matrix = JSON.parse(fs.readFileSync(matrixPath, "utf8"));
const args = new Set(process.argv.slice(2));
const planOnly = args.has("--plan");
const selectedIds = valueAfter("--fixtures")?.split(",").filter(Boolean) || matrix.fixtures.map((fixture) => fixture.id);
const workdir = valueAfter("--workdir") || path.join(os.tmpdir(), "cargo-container-ecosystem-fixtures");
const outputPath = valueAfter("--output") || path.join(root, "compat/ecosystem-fixture-results.json");

const selected = matrix.fixtures.filter((fixture) => selectedIds.includes(fixture.id));
if (selected.length !== selectedIds.length) {
  const known = new Set(matrix.fixtures.map((fixture) => fixture.id));
  const missing = selectedIds.filter((id) => !known.has(id));
  throw new Error(`Unknown fixture id: ${missing.join(", ")}`);
}

const results = selected.map((fixture) => planOnly ? plannedResult(fixture) : scoreFixture(fixture));
const payload = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  source: "compat/ecosystem-fixtures.json",
  minimumPassForMilestoneB: matrix.scope.minimumPassForMilestoneB,
  results,
  summary: summarize(results)
};

if (planOnly) {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
} else {
  fs.writeFileSync(outputPath, `${JSON.stringify(payload, null, 2)}\n`);
  process.stdout.write(`ecosystem fixture results written: ${path.relative(root, outputPath)}\n`);
}

function plannedResult(fixture) {
  return {
    id: fixture.id,
    name: fixture.name,
    mode: "plan",
    packageManager: fixture.packageManager,
    repository: fixture.repository,
    subdirectory: fixture.subdirectory || null,
    expectedCommands: fixture.expectedCommands,
    score: 0,
    status: "not-run",
    unsupportedBlocker: false,
    criteria: matrix.scoringRubric.criteria.map((criterion) => ({
      id: criterion.id,
      points: criterion.points,
      status: "not-run"
    }))
  };
}

function scoreFixture(fixture) {
  const checkout = path.join(workdir, fixture.id);
  const projectDir = fixture.subdirectory ? path.join(checkout, fixture.subdirectory) : checkout;
  const criteria = [];
  fs.mkdirSync(workdir, { recursive: true });
  if (!fs.existsSync(checkout)) {
    const clone = run("git", ["clone", "--depth", "1", fixture.repository, checkout], workdir);
    if (clone.status !== 0) return failedResult(fixture, "install", clone);
  }

  const install = runCommandString(fixture.expectedCommands.install, projectDir);
  criteria.push(criterion("install", install.status === 0, install));
  const build = runCommandString(fixture.expectedCommands.build, projectDir);
  criteria.push(criterion("build-dist", build.status === 0, build));

  criteria.push({
    id: "dev-preview",
    points: 25,
    status: "not-run",
    note: "Use the interactive harness to start dev server and assert rendered DOM."
  });
  criteria.push({
    id: "edit-hmr",
    points: 25,
    status: "not-run",
    note: "Use the interactive harness to edit source and capture HMR event log."
  });

  const score = criteria.reduce((total, entry) => total + (entry.status === "pass" ? entry.points : 0), 0);
  return {
    id: fixture.id,
    name: fixture.name,
    mode: "measured-reference",
    packageManager: fixture.packageManager,
    repository: fixture.repository,
    subdirectory: fixture.subdirectory || null,
    score,
    status: classifyScore(score, false),
    unsupportedBlocker: false,
    criteria
  };
}

function failedResult(fixture, criterionId, result) {
  return {
    id: fixture.id,
    name: fixture.name,
    mode: "measured-reference",
    packageManager: fixture.packageManager,
    repository: fixture.repository,
    subdirectory: fixture.subdirectory || null,
    score: 0,
    status: "partial-pass",
    unsupportedBlocker: false,
    criteria: [
      criterion(criterionId, false, result),
      ...matrix.scoringRubric.criteria
        .filter((entry) => entry.id !== criterionId)
        .map((entry) => ({ id: entry.id, points: entry.points, status: "not-run" }))
    ]
  };
}

function criterion(id, passed, result) {
  const spec = matrix.scoringRubric.criteria.find((entry) => entry.id === id);
  return {
    id,
    points: spec?.points || 0,
    status: passed ? "pass" : "fail",
    exitCode: result.status,
    stdoutTail: tail(result.stdout),
    stderrTail: tail(result.stderr)
  };
}

function summarize(results) {
  const passCount = results.filter((result) => result.status === "pass").length;
  return {
    total: results.length,
    passCount,
    milestoneB: passCount >= matrix.scope.minimumPassForMilestoneB ? "pass" : "not-yet"
  };
}

function classifyScore(score, unsupportedBlocker) {
  if (unsupportedBlocker) return "unsupported";
  if (score >= 80) return "pass";
  if (score >= 50) return "partial-pass";
  return "hold";
}

function runCommandString(command, cwd) {
  const [bin, ...argv] = command.split(/\s+/).filter(Boolean);
  if (!bin) throw new Error(`empty command for ${cwd}`);
  return run(bin, argv, cwd);
}

function run(bin, argv, cwd) {
  return spawnSync(bin, argv, {
    cwd,
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 10,
    shell: false
  });
}

function tail(value = "") {
  const lines = value.split(/\r?\n/).filter(Boolean);
  return lines.slice(-20).join("\n");
}

function valueAfter(name) {
  const prefix = `${name}=`;
  return process.argv.slice(2).find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}
