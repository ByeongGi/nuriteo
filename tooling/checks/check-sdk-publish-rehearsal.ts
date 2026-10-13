import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const packageRoot = path.resolve("dist/sdk/package");
const sourceManifest = JSON.parse(fs.readFileSync("packages/sdk/package.json", "utf8"));
const packageTarball = path.resolve(`dist/sdk/nuriteo-sdk-${sourceManifest.version}.tgz`);
const packagedManifest = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));

assert.match(sourceManifest.version, /^0\.1\.0-beta\.\d+$/, "SDK source version must use the beta channel");
assert.equal(sourceManifest.private, undefined, "SDK source package must not be private");
assert.deepEqual(packagedManifest.publishConfig, {
  access: "public",
  provenance: true,
  tag: "beta"
});
assert.equal(packagedManifest.version, sourceManifest.version);
assert.equal(packagedManifest.private, undefined, "packaged SDK must be publishable");
assert.ok(fs.existsSync(packageTarball), "packaged SDK tarball is required");

const cache = fs.mkdtempSync(path.join(os.tmpdir(), "nuriteo-sdk-publish-"));
try {
  const rehearsal = spawnSync("npm", [
    "pack",
    packageRoot,
    "--dry-run",
    "--ignore-scripts",
    "--json",
    "--pack-destination",
    cache,
    "--cache",
    cache
  ], { encoding: "utf8", env: { ...process.env, npm_config_loglevel: "error" }, timeout: 30_000 });
  assert.equal(rehearsal.status, 0, rehearsal.stderr || rehearsal.stdout);
  const [output] = JSON.parse(rehearsal.stdout);
  assert.equal(output.name, "@nuriteo/sdk");
  assert.equal(output.version, sourceManifest.version);
  assert.ok(output.files.some((file) => file.path === "index.js"));
  assert.ok(output.files.some((file) => file.path === "index.cjs"));
  assert.ok(output.files.some((file) => file.path === "index.d.ts"));
  assert.ok(output.files.some((file) => file.path === "assets/system_wasm.wasm"));
} finally {
  fs.rmSync(cache, { recursive: true, force: true });
}

console.log(`SDK publish rehearsal ok version=${sourceManifest.version} tag=beta`);
