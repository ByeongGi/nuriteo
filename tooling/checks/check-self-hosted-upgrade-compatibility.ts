import { execFileSync } from "node:child_process";
import fs from "node:fs";

import {
  type RcBaseline,
  type UpgradeCompatibility,
  sha256,
  validateUpgradeCompatibility,
} from "./lib/self-hosted-upgrade-compatibility.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const compatibilityPath = process.argv[2] ?? "release/gates/self-hosted-upgrade-compatibility-v1.json";
const compatibility = JSON.parse(fs.readFileSync(compatibilityPath, "utf8")) as UpgradeCompatibility;
const baselinePath = compatibility.sourceBaseline.path;
const baselineBytes = fs.readFileSync(baselinePath);
const baseline = JSON.parse(baselineBytes.toString("utf8")) as RcBaseline;

validateUpgradeCompatibility(compatibility, baseline, baselineBytes);

const commitExists = (revision: string): boolean => {
  try {
    execFileSync("git", ["cat-file", "-e", `${revision}^{commit}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

const baselineCommitPresent = commitExists(baseline.baselineCommit);
if (baselineCommitPresent) {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", baseline.baselineCommit, "HEAD"], { stdio: "ignore" });
  } catch {
    throw new Error("current HEAD must descend from the RC baseline commit");
  }
}

const gitBytes = (revision: string, path: string): Buffer =>
  execFileSync("git", ["show", `${revision}:${path}`]);

const migrationDirectory = "crates/nuriteo-server/migrations";
const currentMigrations = fs.readdirSync(migrationDirectory)
  .filter((name) => /^\d{4}_.+\.sql$/u.test(name))
  .sort();
const frozenNames = currentMigrations.filter((name) => {
  const version = Number(name.slice(0, 4));
  return version >= compatibility.schema.immutablePrefix.first && version <= compatibility.schema.immutablePrefix.last;
});
const baselineMigrations = baselineCommitPresent
  ? execFileSync(
      "git",
      ["ls-tree", "-r", "--name-only", baseline.baselineCommit, "--", migrationDirectory],
      { encoding: "utf8" },
    )
      .trim()
      .split("\n")
      .filter((path) => /\/\d{4}_.+\.sql$/u.test(path))
      .sort()
  : frozenNames.map((name) => `${migrationDirectory}/${name}`);
assert(baselineMigrations.length === compatibility.schema.immutablePrefix.count, "baseline migration count drifted");
const currentVersions = new Set<number>();
for (const name of currentMigrations) {
  const version = Number(name.slice(0, 4));
  assert(!currentVersions.has(version), `migration ${version} appears more than once`);
  currentVersions.add(version);
}
const frozenEntries: string[] = [];
for (let version = compatibility.schema.immutablePrefix.first; version <= compatibility.schema.immutablePrefix.last; version += 1) {
  const prefix = version.toString().padStart(4, "0");
  const baselinePath = baselineMigrations.find((path) => path.includes(`/migrations/${prefix}_`));
  assert(baselinePath !== undefined, `baseline migration ${prefix} is missing`);
  assert(fs.existsSync(baselinePath), `frozen migration ${prefix} was removed or renamed`);
  const currentHash = sha256(fs.readFileSync(baselinePath));
  if (baselineCommitPresent) {
    assert(
      currentHash === sha256(gitBytes(baseline.baselineCommit, baselinePath)),
      `frozen migration ${prefix} changed`,
    );
  }
  frozenEntries.push(`${baselinePath}\0${currentHash}`);
}
if (!baselineCommitPresent) {
  assert(
    sha256(frozenEntries.join("\n")) === compatibility.schema.aggregateSha256,
    "frozen migration prefix does not match the recorded aggregate",
  );
}
const highestVersion = Math.max(...currentVersions);
for (let version = compatibility.schema.immutablePrefix.first; version <= highestVersion; version += 1) {
  assert(currentVersions.has(version), `append-only migration sequence has a gap at ${version}`);
}

const configSource = compatibility.configuration.definitionSource;
if (baselineCommitPresent) {
  assert(
    sha256(gitBytes(baseline.baselineCommit, configSource.path)) === configSource.baselineSha256,
    "configuration registry baseline fingerprint mismatch",
  );
}
const currentConfigSource = fs.readFileSync(configSource.path, "utf8");
assert(
  sha256(currentConfigSource) === configSource.baselineSha256,
  "configuration registry changed without a compatibility manifest update",
);
const registryVersion = currentConfigSource.match(
  /pub const INSTANCE_SETTING_REGISTRY_VERSION: u16 = (\d+);/u,
);
assert(registryVersion !== null, "configuration registry version declaration is missing");
assert(Number(registryVersion[1]) === compatibility.configuration.registryVersion, "configuration registry version drifted");

const admission = compatibility.objects.admissionContract;
assert(fs.existsSync(admission.path), "Bundle admission contract is missing");
assert(sha256(fs.readFileSync(admission.path)) === admission.sha256, "Bundle admission contract drifted");
const bundle = JSON.parse(fs.readFileSync(admission.path, "utf8")) as { bundleFormat?: string };
assert(bundle.bundleFormat === compatibility.objects.writeFormat, "Bundle admission format drifted");

console.log(
  `self-hosted upgrade compatibility ok (schema ${compatibility.schema.sourceMigration}, `
  + `${compatibility.objects.writeFormat}, config registry ${compatibility.configuration.registryVersion}, `
  + `${compatibility.images.roles.length} digest-pinned images)`,
);
