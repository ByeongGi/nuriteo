import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildManifest, validateInventory, verifyManifest } from "./offline-manifest.mjs";

const inventoryPath = path.resolve("release/offline/inventory-v1.json");
const inventory = JSON.parse(fs.readFileSync(inventoryPath, "utf8"));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "nuriteo-air-001-"));

try {
  const artifacts = validateInventory(inventory);
  for (const artifact of artifacts.values()) {
    const destination = path.join(root, artifact.path);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    const content = artifact.kind === "oci-digest"
      ? `sha256:${artifact.id.charCodeAt(0).toString(16).padStart(2, "0").repeat(32)}\n`
      : `${artifact.id}\n`;
    fs.writeFileSync(destination, content);
  }
  const manifest = buildManifest(
    inventory,
    root,
    "a".repeat(40),
    "2026-10-11T00:00:00.000Z",
  );
  fs.writeFileSync(path.join(root, "release-manifest.json"), `${JSON.stringify(manifest)}\n`);
  assert.deepEqual(verifyManifest(manifest, inventory, root), { artifacts: 36, bundles: 2 });
  assert.equal(manifest.artifacts.filter(({ kind }) => kind === "oci-image").length, 6);
  assert.ok(manifest.artifacts.every(({ sha256 }) => /^[a-f0-9]{64}$/u.test(sha256)));

  fs.appendFileSync(path.join(root, "core/compose/compose.yaml"), "tampered\n");
  assert.throws(() => verifyManifest(manifest, inventory, root), /drift/u);
  fs.writeFileSync(path.join(root, "core/compose/compose.yaml"), "compose\n");

  fs.writeFileSync(path.join(root, "undeclared"), "no\n");
  assert.throws(() => buildManifest(inventory, root, "a".repeat(40), "2026-10-11T00:00:00.000Z"), /file set/u);
  fs.rmSync(path.join(root, "undeclared"));

  const required = path.join(root, "scripts/verify");
  fs.rmSync(required);
  assert.throws(() => buildManifest(inventory, root, "a".repeat(40), "2026-10-11T00:00:00.000Z"), /file set/u);
  fs.writeFileSync(required, "verify\n");

  const sentinel = path.join(root, "core/images/nuriteo-server.digest");
  fs.writeFileSync(sentinel, `sha256:${"0".repeat(64)}\n`);
  assert.throws(() => buildManifest(inventory, root, "a".repeat(40), "2026-10-11T00:00:00.000Z"), /sentinel/u);

  const unsafe = structuredClone(inventory);
  unsafe.bundles[0].artifacts[0].path = "../escape";
  assert.throws(() => validateInventory(unsafe), /unsafe/u);
  console.log("offline release manifest contract ok (complete files, OCI digests, SBOM and license inventory)");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
