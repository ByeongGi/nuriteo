import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { buildManifest, validateInventory } from "../../../tooling/release/offline-manifest.mjs";

const repository = path.resolve(".");
const inventory = JSON.parse(fs.readFileSync(path.join(repository, "release/offline/inventory-v1.json"), "utf8"));
const artifacts = validateInventory(inventory);
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "nuriteo-rc005-"));
const bundle = path.join(temporary, "bundle");
const install = path.join(temporary, "verified-install");
const rcArchiveDirectory = process.env.NURITEO_RC_IMAGE_ARCHIVE_DIR;
const rcManifestPath = process.env.NURITEO_RC_MANIFEST;
const rcManifest = rcManifestPath ? JSON.parse(fs.readFileSync(rcManifestPath, "utf8")) : undefined;

function run(command, arguments_, options = {}) {
  const result = spawnSync(command, arguments_, { cwd: repository, encoding: "utf8", ...options });
  assert.equal(result.status, 0, `${command} ${arguments_.join(" ")} failed:\n${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function copy(source, destination) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(path.join(repository, source), destination);
}

try {
  run("node", ["tooling/checks/check-self-hosted-legacy-replacement.ts"]);
  run("node", ["tooling/checks/check-stale-legacy-references.ts"]);
  run("node", ["tooling/checks/check-legacy-production-boundaries.ts"]);

  const actualSources = new Map([
    ["compose", "deploy/compose/compose.yaml"],
    ["compose-external-s3", "deploy/compose/compose.external-s3.yaml"],
    ["release-manifest-schema", "release/offline/release-manifest-v1.schema.json"],
    ["upgrade-compatibility", "compat/self-hosted-upgrade-compatibility-v1.json"],
    ["import-images", "release/offline/scripts/import-images"],
    ["render-config", "release/offline/scripts/render-config"],
    ["verify", "release/offline/scripts/verify"],
    ["verify-install", "release/offline/scripts/verify-install"],
    ["nuriteo-license", "LICENSE"],
    ["nuriteo-notice", "NOTICE"],
  ]);

  for (const artifact of artifacts.values()) {
    const destination = path.join(bundle, artifact.path);
    const actual = actualSources.get(artifact.id);
    if (actual) {
      copy(actual, destination);
      if (artifact.kind === "script") fs.chmodSync(destination, 0o755);
      continue;
    }
    const rcRole = artifact.id.match(/^(server|web|operations)-image(?:-digest)?$/u)?.[1];
    if (rcArchiveDirectory && rcManifest && rcRole && artifact.kind === "oci-image") {
      copy(path.relative(repository, path.join(rcArchiveDirectory, `${rcRole}.oci.tar`)), destination);
      continue;
    }
    if (rcArchiveDirectory && rcManifest && rcRole && artifact.kind === "oci-digest") {
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      const image = rcManifest.images.find(({ role }) => role === rcRole);
      assert(image, `RC image is missing: ${rcRole}`);
      fs.writeFileSync(destination, `${image.digest}\n`);
      continue;
    }
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    if (artifact.kind === "oci-digest") {
      fs.writeFileSync(destination, `sha256:${sha256(artifact.id)}\n`);
    } else if (artifact.kind === "sbom") {
      fs.writeFileSync(destination, `${JSON.stringify({ spdxVersion: "SPDX-2.3", name: artifact.id })}\n`);
    } else {
      fs.writeFileSync(destination, `RC-005 offline fixture: ${artifact.id}\n`);
    }
  }

  const chartDestination = path.dirname(path.join(bundle, artifacts.get("helm-chart").path));
  fs.mkdirSync(chartDestination, { recursive: true });
  run("helm", ["package", "charts/nuriteo", "--destination", chartDestination]);

  const sourceCommit = rcManifest?.sourceCommit ?? run("git", ["rev-parse", "HEAD"]);
  const manifest = buildManifest(inventory, bundle, sourceCommit, "2026-10-11T00:00:00.000Z");
  fs.writeFileSync(path.join(bundle, "release-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  run(path.join(bundle, "scripts/verify-install"), [
    bundle,
    "registry.internal:5443",
    "nuriteo",
    install,
    "10.40.12.0/24",
  ]);

  const plan = JSON.parse(fs.readFileSync(path.join(install, "install-plan.json"), "utf8"));
  assert.equal(plan.releaseLineage, inventory.releaseLineage);
  assert.equal(plan.release, inventory.release);
  assert.equal(plan.registry, "registry.internal:5443/nuriteo");
  assert.equal(plan.networkPolicy.defaultDeny, true);
  assert.deepEqual(plan.networkPolicy.externalEgressCidrs, ["10.40.12.0/24"]);
  assert.equal(plan.workloadImages.length, 3);
  assert.equal(new Set(plan.workloadImages).size, 3);
  assert(plan.workloadImages.every((image) => image.startsWith("registry.internal:5443/nuriteo/")));

  if (rcArchiveDirectory && rcManifest) {
    for (const { role, digest } of rcManifest.images) {
      const inspected = JSON.parse(run("skopeo", ["inspect", `oci-archive:${path.join(rcArchiveDirectory, `${role}.oci.tar`)}`]));
      assert.equal(inspected.Digest, digest, `RC archive digest drift: ${role}`);
    }
  }

  const compatibility = JSON.parse(fs.readFileSync(path.join(bundle, "core/configuration/self-hosted-upgrade-compatibility-v1.json"), "utf8"));
  assert.equal(compatibility.releaseLineage, inventory.releaseLineage);
  assert.equal(compatibility.support.upgradeTo, inventory.release);
  assert.equal(compatibility.support.failurePolicy, "stop-before-mutation");

  for (const forbidden of ["apps/preview-service", "packages/service-backend", "examples/runtime-lab"] ) {
    assert(!manifest.artifacts.some(({ path: artifactPath }) => artifactPath.includes(forbidden)), `legacy artifact leaked: ${forbidden}`);
  }

  console.log(JSON.stringify({
    status: "pass",
    task: "RC-005",
    sourceCommit,
    releaseLineage: manifest.releaseLineage,
    release: manifest.release,
    inventorySha256: manifest.inventorySha256,
    artifacts: manifest.artifacts.length,
    bundles: manifest.bundles.length,
    workloadImages: plan.workloadImages.length,
    defaultDeny: plan.networkPolicy.defaultDeny,
    canonicalSurfaces: ["apps/web", "crates/nuriteo-server", "packages/workspace-runtime"],
    staleLegacyReferences: 0,
    coreImagePayloads: rcArchiveDirectory ? "actual" : "synthetic",
    optionalQuickstartPayloads: "synthetic",
  }));
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
