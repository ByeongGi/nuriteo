import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { assert as fingerprintAssert } from "./release-fingerprint.ts";

export const RELEASE_CHANNELS_PATH = "compat/release-channels.json";
export const RELEASE_ASSET_POLICY_PATH = "compat/release-asset-policy.json";
export const RELEASE_CHECKLIST_PATH = "compat/release-checklist.json";

export const CHANNEL_IDS = Object.freeze([
  "internal",
  "private-beta",
  "public-beta",
  "stable"
]);

/** Project snapshot migration contract bound into SG29 release ops. */
export const migrationContract = Object.freeze({
  record: "ProjectSnapshot",
  currentSchemaVersion: 1,
  supportedSchemaVersions: Object.freeze([1]),
  onUnsupportedVersion: "reject-load-preserve-bytes",
  dataLossPolicy: "migration failure must leave original snapshot bytes untouched",
  migrate(snapshot) {
    if (!snapshot || typeof snapshot !== "object") {
      throw new Error("migrationContract: snapshot must be an object");
    }
    const version = snapshot.schemaVersion;
    if (!this.supportedSchemaVersions.includes(version)) {
      throw new Error(
        `migrationContract: unsupported ProjectSnapshot schemaVersion ${version}; original bytes must be preserved`
      );
    }
    return {
      ...snapshot,
      schemaVersion: this.currentSchemaVersion
    };
  },
  assertSafeFailure(originalBytes, attemptedBytes) {
    if (originalBytes !== attemptedBytes) {
      throw new Error("migrationContract: migration failure mutated original snapshot bytes");
    }
    return true;
  }
});

export function readJson(file, { root = process.cwd() } = {}) {
  return JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
}

export function loadReleaseChannels({ root = process.cwd() } = {}) {
  const channels = readJson(RELEASE_CHANNELS_PATH, { root });
  fingerprintAssert(channels.schemaVersion === 1, "release-channels schemaVersion must be 1");
  fingerprintAssert(CHANNEL_IDS.includes(channels.currentChannel), `unknown currentChannel: ${channels.currentChannel}`);
  const ids = (channels.channels || []).map((entry) => entry.id);
  for (const id of CHANNEL_IDS) {
    fingerprintAssert(ids.includes(id), `release-channels missing channel: ${id}`);
  }
  return channels;
}

export function loadReleaseAssetPolicy({ root = process.cwd() } = {}) {
  const policy = readJson(RELEASE_ASSET_POLICY_PATH, { root });
  fingerprintAssert(policy.schemaVersion === 1, "release-asset-policy schemaVersion must be 1");
  fingerprintAssert(policy.versionedAssetLayout?.assetSetRoot, "release-asset-policy missing versionedAssetLayout.assetSetRoot");
  fingerprintAssert(policy.cacheHeaders?.immutableVersionedAssets, "release-asset-policy missing immutable cache headers");
  fingerprintAssert(policy.rollback?.strategy === "switch-channel-pointer-to-previous-asset-set", "unexpected rollback strategy");
  fingerprintAssert(Array.isArray(policy.boundReleaseDocs) && policy.boundReleaseDocs.length >= 2, "boundReleaseDocs must include matrix + limitations");
  return policy;
}

export function assetSetIdFromFingerprint(fingerprint) {
  const sdk = fingerprint?.sdkPackage;
  fingerprintAssert(sdk?.assetManifestSha256, "fingerprint missing assetManifestSha256");
  fingerprintAssert(sdk?.systemWasmSha256, "fingerprint missing systemWasmSha256");
  fingerprintAssert(sdk?.tarballSha256, "fingerprint missing tarballSha256");
  const material = [
    sdk.assetManifestSha256,
    sdk.systemWasmSha256,
    sdk.systemWorkerSha256 || "",
    sdk.processWorkerSha256 || "",
    sdk.tarballSha256
  ].join(":");
  return createHash("sha256").update(material).digest("hex").slice(0, 16);
}

function expandLayout(template, { channel, assetSetId }) {
  return template
    .replaceAll("{channel}", channel)
    .replaceAll("{assetSetId}", assetSetId);
}

/**
 * Plan a versioned SDK/runtime asset deployment for a release channel.
 * @param {string} channel
 * @param {object} fingerprint docs/release/fingerprint.json shape
 * @param {{ root?: string, policy?: object, generatedAt?: string }} [options]
 */
export function planRelease(channel, fingerprint, {
  root = process.cwd(),
  policy = loadReleaseAssetPolicy({ root }),
  generatedAt = new Date().toISOString()
} = {}) {
  fingerprintAssert(CHANNEL_IDS.includes(channel), `unsupported release channel: ${channel}`);
  fingerprintAssert(fingerprint?.schemaVersion === 2, "release fingerprint schemaVersion must be 2");

  const assetSetId = assetSetIdFromFingerprint(fingerprint);
  const layout = policy.versionedAssetLayout;
  const rootPath = expandLayout(layout.assetSetRoot, { channel, assetSetId });
  const boundDocs = (policy.boundReleaseDocs || []).map((sourcePath) => ({
    sourcePath,
    deployPath: `${rootPath}${path.basename(sourcePath)}`
  }));

  for (const doc of boundDocs) {
    fingerprintAssert(fs.existsSync(path.join(root, doc.sourcePath)), `missing bound release doc: ${doc.sourcePath}`);
  }

  return {
    kind: "release-plan",
    channel,
    assetSetId,
    generatedAt,
    paths: {
      assetSetRoot: rootPath,
      channelPointer: expandLayout(layout.channelPointer, { channel, assetSetId }),
      previousPointer: expandLayout(layout.previousPointer, { channel, assetSetId })
    },
    hashes: {
      assetManifestSha256: fingerprint.sdkPackage.assetManifestSha256,
      systemWasmSha256: fingerprint.sdkPackage.systemWasmSha256,
      systemWorkerSha256: fingerprint.sdkPackage.systemWorkerSha256,
      processWorkerSha256: fingerprint.sdkPackage.processWorkerSha256,
      tarballSha256: fingerprint.sdkPackage.tarballSha256
    },
    cacheHeaders: policy.cacheHeaders,
    boundDocs,
    migrationContract: {
      ...policy.migrationContract,
      currentSchemaVersion: migrationContract.currentSchemaVersion
    },
    activation: {
      writeCurrentPointerTo: expandLayout(layout.channelPointer, { channel, assetSetId }),
      activeAssetSetId: assetSetId
    }
  };
}

/**
 * Plan automated rollback by switching the channel pointer to the previous asset set.
 * Local rehearsal may pass synthetic hash sets without touching a CDN.
 * @param {object} current active asset set descriptor ({ assetSetId, hashes?, channel? })
 * @param {object} previous previous asset set descriptor ({ assetSetId, hashes?, channel? })
 */
export function planRollback(current, previous) {
  fingerprintAssert(current?.assetSetId, "planRollback requires current.assetSetId");
  fingerprintAssert(previous?.assetSetId, "planRollback requires previous.assetSetId");
  fingerprintAssert(current.assetSetId !== previous.assetSetId, "planRollback requires distinct current and previous asset sets");

  const channel = current.channel || previous.channel || "internal";
  return {
    kind: "rollback-plan",
    channel,
    fromAssetSetId: current.assetSetId,
    toAssetSetId: previous.assetSetId,
    strategy: "switch-channel-pointer-to-previous-asset-set",
    rehearsalMode: "local-hash-set-switch-without-cdn",
    pointerUpdates: {
      current: previous.assetSetId,
      previous: current.assetSetId
    },
    hashes: {
      current: current.hashes || null,
      previous: previous.hashes || null
    },
    notes: "Rollback switches the channel pointer only; immutable versioned bytes stay addressable."
  };
}

/**
 * Fail when local fingerprint hashes drift from the committed release fingerprint.
 * Reuses the same hash fields checked by release-fingerprint verification.
 */
export function assertFingerprintNoDrift(local, committed) {
  fingerprintAssert(local?.sdkPackage && committed?.sdkPackage, "fingerprint objects must include sdkPackage");

  const fields = [
    "assetManifestSha256",
    "systemWasmSha256",
    "systemWorkerSha256",
    "processWorkerSha256",
    "tarballSha256",
    "basePath",
    "tarballPath"
  ];

  for (const field of fields) {
    const left = local.sdkPackage[field];
    const right = committed.sdkPackage[field];
    fingerprintAssert(
      left === right,
      `fingerprint drift on sdkPackage.${field}: local=${left} committed=${right}`
    );
  }

  fingerprintAssert(local.schemaVersion === committed.schemaVersion, "fingerprint schemaVersion drift");
  return true;
}

export function assertChecklistElevatedToCiGate(checklist, {
  requiredSubstrings = ["package-sdk", "check-release-readiness"]
} = {}) {
  const commands = [
    ...(checklist.requiredChecks || []),
    ...((checklist.ciGate && checklist.ciGate.requiredCommands) || [])
  ];
  const joined = commands.join("\n");
  for (const needle of requiredSubstrings) {
    fingerprintAssert(
      joined.includes(needle),
      `release checklist CI gate missing required command fragment: ${needle}`
    );
  }
  return true;
}
