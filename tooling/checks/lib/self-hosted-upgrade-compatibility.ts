import { createHash } from "node:crypto";

export type RcBaseline = {
  schemaVersion: number;
  taskId: string;
  releaseLineage: string;
  baselineCommit: string;
  sourceGate: { id: string; status: string; releaseCommit: string };
  contracts: {
    migrationPrefix: { first: number; last: number; count: number; aggregateSha256: string };
    bundleFormat: string;
  };
  images: Array<{ name: string; digest: string }>;
  artifacts: Array<{ path: string; sha256: string }>;
};

export type UpgradeCompatibility = {
  schemaVersion: number;
  taskId: string;
  releaseLineage: string;
  recordedAt: string;
  sourceBaseline: {
    path: string;
    sha256: string;
    taskId: string;
    baselineCommit: string;
    releaseCommit: string;
  };
  support: {
    upgradeFrom: string;
    upgradeTo: string;
    direction: string;
    downgrade: string;
    failurePolicy: string;
  };
  schema: {
    engine: string;
    sourceMigration: number;
    immutablePrefix: { first: number; last: number; count: number };
    aggregateSha256: string;
    historyPolicy: string;
    candidatePolicy: string;
  };
  objects: {
    storageProtocol: string;
    readFormats: string[];
    writeFormat: string;
    admissionContract: { path: string; sha256: string };
    existingObjectPolicy: string;
    rewritePolicy: string;
  };
  configuration: {
    registryVersion: number;
    definitionSource: { path: string; baselineSha256: string };
    persistedAuthority: string;
    unknownKeyPolicy: string;
    futureRegistryPolicy: string;
    compatibility: string;
  };
  images: {
    identity: string;
    setPolicy: string;
    roles: Array<{ name: string; digest: string }>;
  };
};

const sha256Pattern = /^[0-9a-f]{64}$/u;
const digestPattern = /^sha256:[0-9a-f]{64}$/u;

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export const sha256 = (bytes: Buffer | string): string =>
  createHash("sha256").update(bytes).digest("hex");

export function validateUpgradeCompatibility(
  compatibility: UpgradeCompatibility,
  baseline: RcBaseline,
  baselineBytes: Buffer | string,
): void {
  invariant(compatibility.schemaVersion === 1, "unexpected upgrade compatibility schema version");
  invariant(compatibility.taskId === "UPG-001", "compatibility manifest must belong to UPG-001");
  invariant(/^\d{4}-\d{2}-\d{2}$/u.test(compatibility.recordedAt), "recordedAt must use YYYY-MM-DD");
  invariant(baseline.schemaVersion === 1 && baseline.taskId === "RC-001", "source must be the RC-001 baseline");
  invariant(baseline.sourceGate.id === "GATE-005" && baseline.sourceGate.status === "PASS", "source gate must be GATE-005 PASS");
  invariant(compatibility.releaseLineage === baseline.releaseLineage, "release lineage drifted from RC baseline");
  invariant(compatibility.sourceBaseline.path === "compat/self-hosted-rc-baseline.json", "unexpected RC baseline path");
  invariant(sha256Pattern.test(compatibility.sourceBaseline.sha256), "invalid RC baseline SHA-256");
  invariant(sha256(baselineBytes) === compatibility.sourceBaseline.sha256, "RC baseline content fingerprint mismatch");
  invariant(compatibility.sourceBaseline.taskId === baseline.taskId, "RC baseline task identity mismatch");
  invariant(compatibility.sourceBaseline.baselineCommit === baseline.baselineCommit, "RC baseline commit mismatch");
  invariant(compatibility.sourceBaseline.releaseCommit === baseline.sourceGate.releaseCommit, "Beta release commit mismatch");

  invariant(compatibility.support.upgradeFrom === "self-hosted-beta-gate-005", "unsupported upgrade source");
  invariant(compatibility.support.upgradeTo === "self-hosted-v1-rc-lineage", "unexpected upgrade target");
  invariant(compatibility.support.direction === "forward-only", "upgrade direction must be forward-only");
  invariant(compatibility.support.downgrade === "not-supported", "schema downgrade must not be advertised");
  invariant(compatibility.support.failurePolicy === "stop-before-mutation", "preflight failure must stop before mutation");

  const baselinePrefix = baseline.contracts.migrationPrefix;
  const prefix = compatibility.schema.immutablePrefix;
  invariant(compatibility.schema.engine === "postgresql", "only the PostgreSQL schema lineage is supported");
  invariant(compatibility.schema.sourceMigration === baselinePrefix.last, "source schema migration drifted");
  invariant(
    prefix.first === baselinePrefix.first && prefix.last === baselinePrefix.last && prefix.count === baselinePrefix.count,
    "immutable migration prefix drifted from RC baseline",
  );
  invariant(compatibility.schema.aggregateSha256 === baselinePrefix.aggregateSha256, "migration aggregate drifted");
  invariant(compatibility.schema.historyPolicy === "exact-prefix-checksum", "migration history must use exact checksums");
  invariant(compatibility.schema.candidatePolicy === "append-only", "candidate migrations must be append-only");

  const admission = baseline.artifacts.find(({ path }) => path === compatibility.objects.admissionContract.path);
  invariant(compatibility.objects.storageProtocol === "s3-compatible", "object storage protocol drifted");
  invariant(
    compatibility.objects.readFormats.length === 1
      && compatibility.objects.readFormats[0] === baseline.contracts.bundleFormat,
    "object read formats must preserve the RC Bundle format",
  );
  invariant(compatibility.objects.writeFormat === baseline.contracts.bundleFormat, "object write format drifted");
  invariant(admission?.sha256 === compatibility.objects.admissionContract.sha256, "Bundle admission fingerprint drifted");
  invariant(compatibility.objects.existingObjectPolicy === "read-in-place", "existing objects must remain readable in place");
  invariant(compatibility.objects.rewritePolicy === "forbidden-during-upgrade", "upgrade must not rewrite stored objects");

  invariant(Number.isSafeInteger(compatibility.configuration.registryVersion), "invalid configuration registry version");
  invariant(compatibility.configuration.registryVersion > 0, "configuration registry version must be positive");
  invariant(
    compatibility.configuration.definitionSource.path === "crates/nuriteo-server/src/config/instance_settings.rs",
    "unexpected configuration registry source",
  );
  invariant(sha256Pattern.test(compatibility.configuration.definitionSource.baselineSha256), "invalid configuration fingerprint");
  invariant(compatibility.configuration.persistedAuthority === "postgresql-after-bootstrap", "persisted configuration authority drifted");
  invariant(compatibility.configuration.unknownKeyPolicy === "fail-closed", "unknown configuration keys must fail closed");
  invariant(compatibility.configuration.futureRegistryPolicy === "fail-closed", "future registry versions must fail closed");
  invariant(compatibility.configuration.compatibility === "exact-registry-version", "configuration version matching must be exact");

  const expectedImages = [...baseline.images].sort((left, right) => left.name.localeCompare(right.name));
  const actualImages = [...compatibility.images.roles].sort((left, right) => left.name.localeCompare(right.name));
  invariant(compatibility.images.identity === "sha256-digest", "image identity must use SHA-256 digests");
  invariant(compatibility.images.setPolicy === "complete-release-set", "upgrade must use one complete release image set");
  invariant(actualImages.length === expectedImages.length, "release image role count drifted");
  invariant(new Set(actualImages.map(({ name }) => name)).size === actualImages.length, "duplicate release image role");
  invariant(new Set(actualImages.map(({ digest }) => digest)).size === actualImages.length, "release image roles must not share a digest");
  for (let index = 0; index < expectedImages.length; index += 1) {
    invariant(actualImages[index].name === expectedImages[index].name, "release image role set drifted");
    invariant(digestPattern.test(actualImages[index].digest), `invalid ${actualImages[index].name} image digest`);
    invariant(actualImages[index].digest === expectedImages[index].digest, `${actualImages[index].name} image digest drifted`);
  }
}
