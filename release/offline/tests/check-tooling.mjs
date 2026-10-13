import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { buildManifest, validateInventory } from "../../../tooling/release/offline-manifest.mjs";

const repository = path.resolve(".");
const inventoryPath = path.join(repository, "release/offline/inventory-v1.json");
const inventory = JSON.parse(fs.readFileSync(inventoryPath, "utf8"));
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "nuriteo-air-002-"));
const bundle = path.join(temporary, "bundle");
const digest = `sha256:${"7".repeat(64)}`;

function run(command, arguments_, options = {}) {
  return spawnSync(command, arguments_, { encoding: "utf8", ...options });
}

try {
  const artifacts = validateInventory(inventory);
  for (const artifact of artifacts.values()) {
    const destination = path.join(bundle, artifact.path);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    if (["verify", "verify-install", "import-images", "render-config"].includes(artifact.id)) {
      fs.copyFileSync(path.join(repository, "release/offline/scripts", artifact.id), destination);
      fs.chmodSync(destination, 0o755);
    } else {
      fs.writeFileSync(destination, artifact.kind === "oci-digest" ? `${digest}\n` : `${artifact.id}\n`);
    }
  }
  const manifest = buildManifest(inventory, bundle, "a".repeat(40), "2026-10-11T00:00:00.000Z");
  fs.writeFileSync(path.join(bundle, "release-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  let result = run(path.join(bundle, "scripts/verify"), [bundle]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /offline bundle verified/u);

  const rendered = path.join(temporary, "rendered");
  result = run(path.join(bundle, "scripts/render-config"), [bundle, "registry.internal:5443", "nuriteo", rendered]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.statSync(rendered).mode & 0o777, 0o700);
  const values = fs.readFileSync(path.join(rendered, "helm-values-airgap.yaml"), "utf8");
  assert.match(values, /imageRegistry: registry\.internal:5443\/nuriteo/u);
  assert.equal((values.match(new RegExp(digest, "gu")) || []).length, 3);
  const environment = fs.readFileSync(path.join(rendered, "compose-images.env"), "utf8");
  assert.match(environment, new RegExp(`NURITEO_SERVER_IMAGE=registry\\.internal:5443/nuriteo/server@${digest}`, "u"));
  result = run(path.join(bundle, "scripts/render-config"), [bundle, "registry.internal:5443", "nuriteo", rendered]);
  assert.notEqual(result.status, 0, "configuration output must not be overwritten");

  const binaryDirectory = path.join(temporary, "bin");
  const certificates = path.join(temporary, "certificates");
  const log = path.join(temporary, "skopeo.log");
  fs.mkdirSync(binaryDirectory);
  fs.mkdirSync(certificates);
  const fakeSkopeo = path.join(binaryDirectory, "skopeo");
  fs.writeFileSync(fakeSkopeo, `#!/bin/sh\nprintf '%s\\n' "$*" >>"$SKOPEO_LOG"\ncase " $* " in *" inspect "*) printf '{"Digest":"${digest}"}\\n';; esac\n`);
  fs.chmodSync(fakeSkopeo, 0o755);
  result = run(path.join(bundle, "scripts/import-images"), [bundle, "registry.internal:5443", "nuriteo", certificates], {
    env: { ...process.env, PATH: `${binaryDirectory}:${process.env.PATH}`, SKOPEO_LOG: log },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim().split("\n").length, 6);
  const calls = fs.readFileSync(log, "utf8");
  assert.equal((calls.match(/^copy /gmu) || []).length, 6);
  assert.equal((calls.match(/^inspect /gmu) || []).length, 6);
  assert.equal((calls.match(/--dest-cert-dir/gu) || []).length, 6);
  assert.equal((calls.match(/--cert-dir/gu) || []).length, 6);
  assert.doesNotMatch(calls, /tls-verify|docker\.io|ghcr\.io/u);

  result = run(path.join(bundle, "scripts/import-images"), [bundle, "https://registry.internal", "nuriteo", certificates], {
    env: { ...process.env, PATH: `${binaryDirectory}:${process.env.PATH}`, SKOPEO_LOG: log },
  });
  assert.notEqual(result.status, 0, "registry URL must fail closed");
  result = run(path.join(bundle, "scripts/render-config"), [bundle, "registry.internal\nimageRegistry: attacker", "nuriteo", path.join(temporary, "unsafe")]);
  assert.notEqual(result.status, 0, "registry YAML injection must fail closed");
  result = run(path.join(bundle, "scripts/verify-install"), [bundle, "registry.internal:5443", "nuriteo", path.join(temporary, "missing-egress")]);
  assert.notEqual(result.status, 0, "an empty egress allowlist must fail closed");
  result = run(path.join(bundle, "scripts/verify-install"), [bundle, "registry.internal:5443", "nuriteo", path.join(temporary, "unbounded-egress"), "0.0.0.0/0"]);
  assert.notEqual(result.status, 0, "an unbounded egress route must fail closed");
  result = run(path.join(bundle, "scripts/verify-install"), [bundle, "registry.internal:5443", "nuriteo", path.join(temporary, "invalid-egress"), "999.1.1.1/33"]);
  assert.notEqual(result.status, 0, "an invalid egress CIDR must fail closed");

  const compose = path.join(bundle, "core/compose/compose.yaml");
  fs.appendFileSync(compose, "tampered\n");
  result = run(path.join(bundle, "scripts/verify"), [bundle]);
  assert.notEqual(result.status, 0, "tampered bundle must fail closed");
  console.log("offline registry tooling contract ok (CA required, digest pinned, no fallback, no overwrite)");
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
