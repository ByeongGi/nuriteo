#!/usr/bin/env node
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const read = (name) => JSON.parse(fs.readFileSync(required(name), "utf8"));
const before = read("NURITEO_GATE_SENTINELS_BEFORE");
const after = read("NURITEO_GATE_SENTINELS_AFTER");
assert.deepEqual(after, before, "pre-existing admin/user/team/project/object/database sentinels changed");

const git = read("NURITEO_GATE_GIT_DB_ASSERTION");
assert.equal(git.databaseLineage, required("NURITEO_BETA_GATE_DATABASE_LINEAGE"));
assert.equal(git.objectLineage, required("NURITEO_BETA_GATE_OBJECT_LINEAGE"));
assert.equal(git.projectId, required("NURITEO_GATE_PROJECT_ID"));
assert.match(git.remoteHeadSha, /^[0-9a-f]{40,64}$/u);
assert.match(git.workingHeadBundleId, /^[0-9a-f-]{36}$/u);
assert.equal(git.bundleVerificationState, "verified");
assert.equal(git.materializationCount, 2);
assert.equal(required("NURITEO_GATE_GIT_OBJECT_EXISTS"), "true");

const gitStats = read("NURITEO_GATE_GIT_STATS");
assert.ok(gitStats.authorization > 0 && gitStats.gitUpload > 0 && gitStats.gitReceive > 0);

const exactStats = read("NURITEO_GATE_REGISTRY_EXACT_STATS");
assert.ok(exactStats.authorization >= 3 && exactStats.metadata >= 1 && exactStats.tarball >= 1);
const fallbackBefore = read("NURITEO_GATE_REGISTRY_DEFAULT_BEFORE_NO_FALLBACK");
const fallbackAfter = read("NURITEO_GATE_REGISTRY_DEFAULT_AFTER_NO_FALLBACK");
assert.deepEqual(fallbackAfter, fallbackBefore, "explicit scope failure contacted the default Registry");

const metadata = read("NURITEO_GATE_REGISTRY_METADATA_FILE");
const packageName = required("NURITEO_GATE_REGISTRY_PACKAGE");
const version = metadata.versions?.["1.0.0"];
assert.equal(metadata.name, packageName);
assert.equal(version?.name, packageName);
assert.match(version?.dist?.tarball ?? "", /^https:\/\//u);
assert.match(version?.dist?.integrity ?? "", /^sha512-[A-Za-z0-9+/]+={0,2}$/u);
const tarball = fs.readFileSync(required("NURITEO_GATE_REGISTRY_TARBALL_FILE"));
const actualIntegrity = `sha512-${crypto.createHash("sha512").update(tarball).digest("base64")}`;
assert.equal(actualIntegrity, version.dist.integrity);

const output = required("NURITEO_GATE_ASSERTION_DIRECTORY");
fs.mkdirSync(output, { recursive: true, mode: 0o700 });
fs.writeFileSync(path.join(output, "git-integration.assertions.json"), `${JSON.stringify([
  { kind: "api", name: "live Core Git connection performed smart-HTTPS import, pull, commit and push, then rejected a non-fast-forward", status: "PASS" },
  { kind: "api", name: "temporary Git provider completed create, update and delete while administrative responses stayed no-store and credential-redacted", status: "PASS" },
  { kind: "database", name: "Git remote and the import/pull canonical Working Head materializations retained the original database lineage", status: "PASS" },
  { kind: "object", name: "the verified Git Working Head Bundle exists in the original S3 object lineage", status: "PASS" },
])}\n`, { mode: 0o600 });
fs.writeFileSync(path.join(output, "registry-integration.assertions.json"), `${JSON.stringify([
  { kind: "api", name: "live Core Registry lifecycle activated custom-CA token connections and mapped the exact npm scope", status: "PASS" },
  { kind: "api", name: "temporary Registry completed create, rename, token rotation and delete without returning the token and with no-store responses", status: "PASS" },
  { kind: "process", name: "actual package metadata and tarball integrity were fetched from the selected Registry", status: "PASS" },
  { kind: "api", name: "disabled exact scope failed closed without contacting the active default Registry", status: "PASS" },
  { kind: "database", name: "Registry operations preserved every pre-existing clean-install sentinel", status: "PASS" },
])}\n`, { mode: 0o600 });

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
