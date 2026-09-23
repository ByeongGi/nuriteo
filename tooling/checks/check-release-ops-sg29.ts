import fs from "node:fs";
import path from "node:path";
import {
  assertChecklistElevatedToCiGate,
  assertFingerprintNoDrift,
  loadReleaseAssetPolicy,
  loadReleaseChannels,
  migrationContract,
  planRelease,
  planRollback,
  RELEASE_CHECKLIST_PATH,
  readJson
} from "../shared/release-ops.ts";
import { FINGERPRINT_PATH } from "../shared/release-fingerprint.ts";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const root = process.cwd();
const channels = loadReleaseChannels({ root });
const policy = loadReleaseAssetPolicy({ root });
const checklist = readJson(RELEASE_CHECKLIST_PATH, { root });
const fingerprint = readJson(FINGERPRINT_PATH, { root });

assert(channels.gate === "SG29", "release-channels gate must be SG29");
assert(policy.gate === "SG29", "release-asset-policy gate must be SG29");
assertChecklistElevatedToCiGate(checklist);

for (const doc of policy.boundReleaseDocs) {
  assert(fs.existsSync(path.join(root, doc)), `missing bound release doc: ${doc}`);
}

const releasePlan = planRelease(channels.currentChannel, fingerprint, { root, policy });
assert(releasePlan.assetSetId.length === 16, "asset set id must be a stable short hash");
assert(releasePlan.paths.assetSetRoot.includes(channels.currentChannel), "release plan must version under channel");
assert(releasePlan.boundDocs.length >= 2, "release plan must bind compatibility matrix and known limitations");
assert(releasePlan.cacheHeaders.immutableVersionedAssets["Cache-Control"].includes("immutable"), "immutable cache policy missing");

// Same-day rollback rehearsal: simulate two asset sets by hash without CDN upload.
const previousFingerprint = {
  ...fingerprint,
  sdkPackage: {
    ...fingerprint.sdkPackage,
    assetManifestSha256: "a".repeat(64),
    systemWasmSha256: "b".repeat(64),
    tarballSha256: "c".repeat(64)
  }
};
const previousPlan = planRelease(channels.currentChannel, previousFingerprint, {
  root,
  policy,
  generatedAt: releasePlan.generatedAt
});
assert(previousPlan.assetSetId !== releasePlan.assetSetId, "rehearsal asset sets must differ");

const rollback = planRollback(
  {
    channel: channels.currentChannel,
    assetSetId: releasePlan.assetSetId,
    hashes: releasePlan.hashes
  },
  {
    channel: channels.currentChannel,
    assetSetId: previousPlan.assetSetId,
    hashes: previousPlan.hashes
  }
);
assert(rollback.pointerUpdates.current === previousPlan.assetSetId, "rollback must activate previous asset set");
assert(rollback.pointerUpdates.previous === releasePlan.assetSetId, "rollback must retain current as previous");
assert(rollback.strategy === policy.rollback.strategy, "rollback strategy must match asset policy");
assert(rollback.rehearsalMode === "local-hash-set-switch-without-cdn", "rollback rehearsal must stay local");

assertFingerprintNoDrift(fingerprint, structuredClone(fingerprint));
let driftFailed = false;
try {
  assertFingerprintNoDrift(fingerprint, previousFingerprint);
} catch (error) {
  driftFailed = /fingerprint drift/.test(String(error?.message || error));
}
assert(driftFailed, "fingerprint drift must fail closed before deploy");

const migrated = migrationContract.migrate({
  schemaVersion: 1,
  projectId: "sg29-rehearsal",
  generation: 1,
  files: [],
  savedAt: releasePlan.generatedAt,
  byteSize: 0
});
assert(migrated.schemaVersion === migrationContract.currentSchemaVersion, "migration must keep current schema");

const originalBytes = JSON.stringify({ schemaVersion: 1, files: [{ path: "a.ts", content: "ok" }] });
let migrationRejected = false;
try {
  migrationContract.migrate(JSON.parse(originalBytes.replace('"schemaVersion":1', '"schemaVersion":99')));
} catch {
  migrationRejected = true;
}
assert(migrationRejected, "unsupported snapshot schemaVersion must reject");
migrationContract.assertSafeFailure(originalBytes, originalBytes);

const operationsDoc = fs.readFileSync(path.join(root, "docs/release/operations.md"), "utf8");
assert(/Release Channels/i.test(operationsDoc), "operations.md must document release channels");
assert(/Rollback/i.test(operationsDoc), "operations.md must document rollback");

console.log(
  `SG29 release-ops ok channel=${channels.currentChannel} assetSet=${releasePlan.assetSetId} rollbackTo=${rollback.toAssetSetId}`
);
