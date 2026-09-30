import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const contract = readJson("compat/sdk-public-release.json");
const matrix = readJson("compat/sdk-consumer-bundler-matrix.json");
const sourceManifest = readJson("packages/sdk/package.json");
const packageManifest = readJson("dist/sdk/package/package.json");
const provenance = readJson("compat/release-provenance.json");

assert.equal(contract.schemaVersion, 1);
assert.equal(contract.version, sourceManifest.version);
assert.equal(contract.status, "publish-rehearsed-not-published");
assert.equal(contract.r05StableSdkServices.status, "pass");
assert.equal(contract.r05StableSdkServices.typedErrors, true);
assert.equal(contract.r05StableSdkServices.lifecycleRecovery, true);
assert.equal(contract.r09WebContainerFacade.status, "pass");
assert.match(contract.r09WebContainerFacade.compatibility, /not-drop-in/);
assert.equal(contract.r12Publish.actualRegistryPublish, false);
assert.equal(contract.r12Publish.status, "rehearsal-pass-external-publish-not-authorized");

assert.equal(sourceManifest.private, undefined);
assert.equal(sourceManifest.version, "0.1.0-beta.1");
assert.deepEqual(sourceManifest.publishConfig, { access: "public", provenance: true, tag: "beta" });
assert.equal(packageManifest.version, sourceManifest.version);
assert.equal(packageManifest.exports["."].default, "./index.js");
assert.equal(packageManifest.exports["."].require, "./index.cjs");
assert.equal(packageManifest.exports["."].types, "./index.d.ts");

for (const relative of [
  contract.r12Publish.artifact,
  "dist/sdk/package/index.js",
  "dist/sdk/package/index.cjs",
  "dist/sdk/package/index.d.ts",
  "docs/productization/sdk-api-freeze-rfc.md",
  "docs/release/sdk-publish-rehearsal.md",
  "tests/contract/sdk-consumer/services.test.ts"
]) assert.ok(fs.existsSync(relative), `missing SDK release evidence: ${relative}`);

assert.equal(matrix.scope.packageArtifact, contract.r12Publish.artifact);
assert.ok(matrix.cases.length >= 4);
assert.ok(matrix.cases.every((entry) => entry.status === "pass"), "all SDK consumers must pass");
assert.equal(matrix.gate.status, "pass");
assert.ok(provenance.ci.requiredCommands.includes("node tooling/checks/check-sdk-publish-rehearsal.ts"));

const apiDoc = fs.readFileSync("docs/productization/sdk-api-freeze-rfc.md", "utf8");
assert.match(apiDoc, /NuriteoMountSnapshot/);
assert.match(apiDoc, /not a drop-in|drop-in replacement/i);
const publishDoc = fs.readFileSync("docs/release/sdk-publish-rehearsal.md", "utf8");
assert.match(publishDoc, /0\.1\.0-beta\.1/);
assert.match(publishDoc, /npm dist-tag add/);
assert.match(publishDoc, /provenance/i);

console.log(`SDK public release gate ok version=${contract.version} status=${contract.status}`);

function readJson(relative) {
  return JSON.parse(fs.readFileSync(path.resolve(relative), "utf8"));
}
