import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";

import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { loadJq } from "jq-wasm";

import {
  createWasiRuntimeBoundary,
  validateWasiEnv,
  validateWasiFilesystemAccess,
  validateWasiNetwork
} from "../../node-runtime/src/wasm-adapters/index.ts";

const root = path.resolve(new URL("../../..", import.meta.url).pathname);
const require = createRequire(import.meta.url);
const matrix = JSON.parse(fs.readFileSync(path.join(root, "compat/non-js-tooling-candidates.json"), "utf8"));
const lockfile = fs.readFileSync(path.join(root, "pnpm-lock.yaml"), "utf8");

for (const candidate of matrix.candidates.filter((entry) => entry.status === "supported")) {
  const packageJsonPath = require.resolve(`${candidate.package.name}/package.json`);
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
  const artifactPath = path.resolve(path.dirname(packageJsonPath), candidate.artifact.path);
  const artifact = fs.readFileSync(artifactPath);
  const sha256 = crypto.createHash("sha256").update(artifact).digest("hex");
  assert.equal(packageJson.version, candidate.package.version, `${candidate.id} package version drifted`);
  assert.ok(lockfile.includes(`integrity: ${candidate.package.registryIntegrity}`), `${candidate.id} registry integrity is not pinned in pnpm-lock.yaml`);
  assert.equal(artifact.byteLength, candidate.artifact.bytes, `${candidate.id} artifact size drifted`);
  assert.equal(sha256, candidate.artifact.sha256, `${candidate.id} artifact integrity mismatch`);
  assert.ok(artifact.byteLength <= candidate.performance.artifactBudgetBytes, `${candidate.id} artifact exceeds budget`);
}

const jq = matrix.candidates.find((entry) => entry.id === "jq-wasm");
const jqPackageRoot = path.dirname(require.resolve("jq-wasm/package.json"));
const jqBytes = fs.readFileSync(path.resolve(jqPackageRoot, jq.artifact.path));
const jqStartedAt = performance.now();
const jqRuntime = await loadJq({ wasmBinary: jqBytes });
const jqColdStartMs = performance.now() - jqStartedAt;
const jqFixturePath = path.join(root, "tests/fixtures/non-js-tooling/jq-input.json");
const boundary = createWasiRuntimeBoundary({ projectRoot: root, readableRoots: [root], writableRoots: [root] });
validateWasiFilesystemAccess(boundary, jqFixturePath, "read");
const jqInput = JSON.parse(fs.readFileSync(jqFixturePath, "utf8"));
assert.deepEqual(
  jqRuntime.json(jqInput, '[.packages[] | select(.kind == "runtime" and .supported) | .name]'),
  [["@nuriteo/runtime", "@nuriteo/preview"]]
);
assert.ok(jqColdStartMs <= jq.performance.coldStartBudgetMs, `jq cold start exceeded budget: ${jqColdStartMs}`);
assert.throws(() => validateWasiFilesystemAccess(boundary, path.resolve(root, "../credential.txt"), "read"), { code: "EWASIPATH" });

const sqlite = matrix.candidates.find((entry) => entry.id === "sqlite-wasm");
const sqliteStartedAt = performance.now();
const sqlite3 = await sqlite3InitModule({ print() {}, printErr() {} });
const sqliteColdStartMs = performance.now() - sqliteStartedAt;
const db = new sqlite3.oo1.DB(":memory:", "c");
try {
  db.exec("CREATE TABLE transaction_fixture (value TEXT NOT NULL)");
  db.exec("BEGIN; INSERT INTO transaction_fixture VALUES ('committed'); COMMIT;");
  db.exec("BEGIN; INSERT INTO transaction_fixture VALUES ('rolled-back'); ROLLBACK;");
  assert.equal(db.selectValue("SELECT COUNT(*) FROM transaction_fixture"), 1);
  assert.equal(db.selectValue("SELECT value FROM transaction_fixture"), "committed");
} finally {
  db.close();
}
assert.ok(sqliteColdStartMs <= sqlite.performance.coldStartBudgetMs, `sqlite cold start exceeded budget: ${sqliteColdStartMs}`);

assert.throws(() => validateWasiEnv(boundary, { NPM_TOKEN: "must-not-reach-tool" }), { code: "EWASIENV" });
assert.throws(() => validateWasiNetwork(boundary, "tcp"), { code: "EWASINETWORK" });
assert.throws(() => validateWasiNetwork(boundary, "fetch"), { code: "EWASINETWORK" });

console.log("node runtime non-JS tooling test ok");
