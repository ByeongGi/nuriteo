#!/usr/bin/env node

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SHA256 = /^[a-f0-9]{64}$/u;
const OCI_DIGEST = /^sha256:[a-f0-9]{64}$/u;
const SAFE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/-]+$/u;

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function encoded(value) {
  return `${JSON.stringify(canonical(value), null, 2)}\n`;
}

function digest(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function exactKeys(value, keys, context) {
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), `${context} fields drift`);
}

export function validateInventory(inventory) {
  exactKeys(inventory, ["schemaVersion", "releaseLineage", "release", "bundles", "licenses"], "inventory");
  assert.equal(inventory.schemaVersion, 1, "unsupported inventory schema");
  assert.match(inventory.releaseLineage, /^[a-z0-9][a-z0-9-]{2,63}$/u);
  assert.match(inventory.release, /^[a-z0-9][a-z0-9.-]{2,127}$/u);
  assert.ok(Array.isArray(inventory.bundles) && inventory.bundles.length === 2, "core and quickstart inventories are required");
  assert.deepEqual(inventory.bundles.map(({ id }) => id), ["core", "quickstart"]);
  assert.equal(inventory.bundles[0].required, true);
  assert.equal(inventory.bundles[1].required, false);

  const licenses = new Set();
  for (const license of inventory.licenses) {
    exactKeys(license, ["id", "name", "spdx", "source"], "license");
    assert.ok(!licenses.has(license.id), "duplicate license id");
    licenses.add(license.id);
    assert.match(license.spdx, /^[A-Za-z0-9-.+]+$/u);
    assert.ok(
      /^https:\/\//u.test(license.source) || SAFE_PATH.test(license.source),
      `invalid license source: ${license.id}`,
    );
  }
  const artifacts = new Map();
  for (const bundle of inventory.bundles) {
    exactKeys(bundle, ["id", "required", "artifacts"], `bundle ${bundle.id}`);
    assert.ok(Array.isArray(bundle.artifacts) && bundle.artifacts.length > 0);
    for (const artifact of bundle.artifacts) {
      const allowed = ["id", "kind", "path", "licenseRefs", "sbomRefs", "ociDigestRef"];
      assert.ok(Object.keys(artifact).every((key) => allowed.includes(key)), `artifact ${artifact.id} fields drift`);
      assert.match(artifact.path, SAFE_PATH, `unsafe artifact path: ${artifact.id}`);
      assert.ok(!artifacts.has(artifact.id), `duplicate artifact id: ${artifact.id}`);
      assert.ok(![...artifacts.values()].some((entry) => entry.path === artifact.path), `duplicate artifact path: ${artifact.path}`);
      assert.ok(Array.isArray(artifact.licenseRefs) && artifact.licenseRefs.length > 0, `license inventory missing: ${artifact.id}`);
      for (const reference of artifact.licenseRefs) assert.ok(licenses.has(reference), `unknown license: ${reference}`);
      artifacts.set(artifact.id, { ...artifact, bundle: bundle.id });
    }
  }
  for (const artifact of artifacts.values()) {
    for (const reference of artifact.sbomRefs || []) {
      assert.equal(artifacts.get(reference)?.kind, "sbom", `invalid SBOM reference: ${reference}`);
    }
    if (artifact.kind === "oci-image") {
      assert.equal(artifacts.get(artifact.ociDigestRef)?.kind, "oci-digest", `OCI digest missing: ${artifact.id}`);
      assert.ok((artifact.sbomRefs || []).length > 0, `OCI SBOM missing: ${artifact.id}`);
    } else {
      assert.equal(artifact.ociDigestRef, undefined, `unexpected OCI digest reference: ${artifact.id}`);
    }
  }
  return artifacts;
}

function regularFiles(root) {
  const files = [];
  function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`symbolic links are forbidden: ${path.relative(root, absolute)}`);
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile()) {
        const relative = path.relative(root, absolute).split(path.sep).join("/");
        if (relative !== "release-manifest.json") files.push(relative);
      }
      else throw new Error(`unsupported artifact type: ${path.relative(root, absolute)}`);
    }
  }
  walk(root);
  return files.sort();
}

function expectedArtifacts(inventory) {
  return inventory.bundles.flatMap((bundle) => bundle.artifacts.map((artifact) => artifact.path)).sort();
}

export function buildManifest(inventory, root, sourceCommit, createdAt) {
  const artifacts = validateInventory(inventory);
  assert.match(sourceCommit, /^[a-f0-9]{40}$/u, "source commit must be an exact SHA-1");
  assert.equal(new Date(createdAt).toISOString(), createdAt, "createdAt must be canonical UTC");
  assert.deepEqual(regularFiles(root), expectedArtifacts(inventory), "bundle file set is incomplete or contains undeclared files");

  const entries = [];
  for (const artifact of artifacts.values()) {
    const absolute = path.join(root, artifact.path);
    const content = fs.readFileSync(absolute);
    const entry = {
      id: artifact.id,
      bundle: artifact.bundle,
      kind: artifact.kind,
      path: artifact.path,
      bytes: content.byteLength,
      sha256: digest(content),
      licenseRefs: artifact.licenseRefs,
    };
    if (artifact.sbomRefs) entry.sbomRefs = artifact.sbomRefs;
    if (artifact.kind === "oci-image") {
      const digestArtifact = artifacts.get(artifact.ociDigestRef);
      const ociDigest = fs.readFileSync(path.join(root, digestArtifact.path), "utf8").trim();
      assert.match(ociDigest, OCI_DIGEST, `invalid OCI digest: ${artifact.id}`);
      assert.notEqual(ociDigest, `sha256:${"0".repeat(64)}`, `sentinel OCI digest: ${artifact.id}`);
      entry.ociDigest = ociDigest;
    }
    entries.push(entry);
  }
  entries.sort((left, right) => left.path.localeCompare(right.path));
  return {
    schemaVersion: 1,
    releaseLineage: inventory.releaseLineage,
    release: inventory.release,
    sourceCommit,
    createdAt,
    inventorySha256: digest(Buffer.from(encoded(inventory))),
    bundles: inventory.bundles.map(({ id, required }) => ({ id, required })),
    licenses: inventory.licenses,
    artifacts: entries,
  };
}

export function verifyManifest(manifest, inventory, root) {
  assert.equal(manifest.schemaVersion, 1, "unsupported release manifest schema");
  assert.equal(manifest.releaseLineage, inventory.releaseLineage, "release lineage drift");
  assert.equal(manifest.release, inventory.release, "release identity drift");
  assert.match(manifest.inventorySha256, SHA256);
  assert.equal(manifest.inventorySha256, digest(Buffer.from(encoded(inventory))), "inventory digest drift");
  const rebuilt = buildManifest(inventory, root, manifest.sourceCommit, manifest.createdAt);
  assert.deepEqual(manifest, rebuilt, "release manifest or bundle contents drift");
  return { artifacts: manifest.artifacts.length, bundles: manifest.bundles.length };
}

function parseArguments(arguments_) {
  const [action, ...rest] = arguments_;
  const values = new Map();
  for (let index = 0; index < rest.length; index += 2) {
    assert.ok(rest[index]?.startsWith("--") && rest[index + 1], "arguments must be --name value pairs");
    values.set(rest[index].slice(2), rest[index + 1]);
  }
  return { action, values };
}

function main(arguments_) {
  const { action, values } = parseArguments(arguments_);
  const inventoryPath = path.resolve(values.get("inventory") || "release/offline/inventory-v1.json");
  const root = path.resolve(values.get("root") || "");
  const manifestPath = path.resolve(values.get("manifest") || path.join(root, "release-manifest.json"));
  const inventory = JSON.parse(fs.readFileSync(inventoryPath, "utf8"));
  if (action === "build") {
    const manifest = buildManifest(inventory, root, values.get("source-commit") || "", values.get("created-at") || "");
    fs.writeFileSync(manifestPath, encoded(manifest), { flag: "wx", mode: 0o644 });
    return { status: "built", artifacts: manifest.artifacts.length, manifest: manifestPath };
  }
  if (action === "verify") {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    return { status: "verified", ...verifyManifest(manifest, inventory, root) };
  }
  throw new Error("usage: offline-manifest.mjs <build|verify> --inventory FILE --root DIR --manifest FILE [--source-commit SHA --created-at UTC]");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(JSON.stringify(main(process.argv.slice(2))));
  } catch (error) {
    console.error(`offline manifest failed (${error instanceof Error ? error.message : "unknown"})`);
    process.exitCode = 1;
  }
}
