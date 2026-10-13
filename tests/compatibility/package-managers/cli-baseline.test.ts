import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { CliRegistry, createGuestCli } from "../../../packages/node-runtime/src/index.ts";

const tempVendorDir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-baseline-vendor-"));
const vendor = spawnSync(process.execPath, [
  new URL("../../../tooling/generators/vendor-cli.ts", import.meta.url).pathname,
  "--from-tarballs",
  "/private/tmp",
  "--out-dir",
  tempVendorDir
], {
  cwd: new URL("../../..", import.meta.url).pathname,
  encoding: "utf8"
});
assert.equal(vendor.status, 0, vendor.stderr);
const { installed } = JSON.parse(vendor.stdout);
const registry = new CliRegistry(installed);
const guestCli = createGuestCli(registry);

const portableRegistry = new CliRegistry([{
  ...installed[0],
  entry: "/stale/checkout/npm-cli.js",
  entryRelative: "vendor/cli/npm/10.9.2/package/bin/npm-cli.js"
}], { root: "/portable/checkout" });
assert.equal(
  portableRegistry.resolve("npm").entry,
  "/portable/checkout/vendor/cli/npm/10.9.2/package/bin/npm-cli.js"
);

for (const name of ["npm", "pnpm"]) {
  const manifest = JSON.parse(fs.readFileSync(new URL(`../../../vendor/manifests/${name}.json`, import.meta.url), "utf8"));
  const entry = registry.resolve(name);
  assert.equal(entry.version, manifest.version);
  assert.ok(entry.entrySha256);
  assert.ok(entry.tarballSha256);
  assert.equal(entry.mode, "real-tarball");
  assert.equal(entry.resolutionPolicy.includes("do-not-replace-dependency-resolution"), true);

  const native = spawnSync(process.execPath, [entry.entry, "--version"], { encoding: "utf8" });
  assert.equal(native.status, 0, native.stderr);
  assert.equal(native.stdout.trim(), manifest.version);

  const result = guestCli.run([name, "--version"]);
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout.trim(), manifest.version);
  assert.equal(result.entrySha256, entry.entrySha256);
}

assert.deepEqual(registry.versions(), {
  npm: "10.9.2",
  pnpm: "9.15.9"
});

console.log("package manager cli baseline test ok");
