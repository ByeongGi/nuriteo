import assert from "node:assert/strict";
import {
  assetSetIdFromFingerprint,
  loadReleaseAssetPolicy,
  loadReleaseChannels,
  migrationContract,
  planRelease,
  planRollback,
  assertFingerprintNoDrift
} from "../../../tooling/shared/release-ops.ts";
import { readJson, FINGERPRINT_PATH } from "../../../tooling/shared/release-fingerprint.ts";

const channels = loadReleaseChannels();
const policy = loadReleaseAssetPolicy();
const fingerprint = readJson(FINGERPRINT_PATH);

const current = planRelease(channels.currentChannel, fingerprint, { policy });
assert.equal(current.kind, "release-plan");
assert.equal(current.channel, channels.currentChannel);
assert.equal(current.assetSetId, assetSetIdFromFingerprint(fingerprint));
assert.ok(current.paths.assetSetRoot.includes(`/sdk/releases/${channels.currentChannel}/`));
assert.equal(current.cacheHeaders.channelPointers["Cache-Control"], "no-cache, must-revalidate");
assert.ok(current.boundDocs.some((doc) => doc.sourcePath.endsWith("public-compatibility-matrix.json")));
assert.ok(current.boundDocs.some((doc) => doc.sourcePath.endsWith("known-limitations.md")));

const previousFingerprint = {
  schemaVersion: 2,
  sdkPackage: {
    ...fingerprint.sdkPackage,
    assetManifestSha256: "11".repeat(32),
    systemWasmSha256: "22".repeat(32),
    systemWorkerSha256: "33".repeat(32),
    processWorkerSha256: "44".repeat(32),
    tarballSha256: "55".repeat(32)
  }
};
const previous = planRelease(channels.currentChannel, previousFingerprint, { policy });
assert.notEqual(previous.assetSetId, current.assetSetId);

const rollback = planRollback(
  { channel: current.channel, assetSetId: current.assetSetId, hashes: current.hashes },
  { channel: previous.channel, assetSetId: previous.assetSetId, hashes: previous.hashes }
);

assert.equal(rollback.kind, "rollback-plan");
assert.equal(rollback.strategy, "switch-channel-pointer-to-previous-asset-set");
assert.equal(rollback.rehearsalMode, "local-hash-set-switch-without-cdn");
assert.equal(rollback.fromAssetSetId, current.assetSetId);
assert.equal(rollback.toAssetSetId, previous.assetSetId);
assert.deepEqual(rollback.pointerUpdates, {
  current: previous.assetSetId,
  previous: current.assetSetId
});

assert.equal(assertFingerprintNoDrift(fingerprint, structuredClone(fingerprint)), true);
assert.throws(
  () => assertFingerprintNoDrift(fingerprint, previousFingerprint),
  /fingerprint drift/
);

assert.equal(migrationContract.currentSchemaVersion, policy.migrationContract.currentSchemaVersion);
assert.throws(
  () => migrationContract.migrate({ schemaVersion: 2, projectId: "x", generation: 1, files: [], savedAt: "", byteSize: 0 }),
  /unsupported ProjectSnapshot schemaVersion/
);

console.log(
  `rollback-rehearsal ok current=${current.assetSetId} previous=${previous.assetSetId} channel=${current.channel}`
);
