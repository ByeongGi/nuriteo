import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  type RcBaseline,
  type UpgradeCompatibility,
  validateUpgradeCompatibility,
} from "../lib/self-hosted-upgrade-compatibility.ts";

const baselineBytes = fs.readFileSync("compat/self-hosted-rc-baseline.json");
const baseline = JSON.parse(baselineBytes.toString("utf8")) as RcBaseline;
const source = JSON.parse(
  fs.readFileSync("compat/self-hosted-upgrade-compatibility-v1.json", "utf8"),
) as UpgradeCompatibility;
const clone = (): UpgradeCompatibility => structuredClone(source);

test("accepts the RC-derived upgrade compatibility contract", () => {
  assert.doesNotThrow(() => validateUpgradeCompatibility(clone(), baseline, baselineBytes));
});

test("rejects a migration prefix that no longer matches the RC baseline", () => {
  const candidate = clone();
  candidate.schema.immutablePrefix.last -= 1;
  assert.throws(
    () => validateUpgradeCompatibility(candidate, baseline, baselineBytes),
    /immutable migration prefix drifted/u,
  );
});

test("rejects an upgrade that rewrites existing objects", () => {
  const candidate = clone();
  candidate.objects.rewritePolicy = "rewrite-all";
  assert.throws(
    () => validateUpgradeCompatibility(candidate, baseline, baselineBytes),
    /must not rewrite stored objects/u,
  );
});

test("rejects permissive handling of future configuration registries", () => {
  const candidate = clone();
  candidate.configuration.futureRegistryPolicy = "best-effort";
  assert.throws(
    () => validateUpgradeCompatibility(candidate, baseline, baselineBytes),
    /future registry versions must fail closed/u,
  );
});

test("rejects a mixed release image set", () => {
  const candidate = clone();
  candidate.images.roles[1].digest = candidate.images.roles[2].digest;
  assert.throws(
    () => validateUpgradeCompatibility(candidate, baseline, baselineBytes),
    /must not share a digest/u,
  );
});
