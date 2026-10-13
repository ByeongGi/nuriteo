#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

const directory = process.argv[2] ?? "release/ga/artifacts";
const channels = JSON.parse(await readFile(path.join(directory, "channels.json"), "utf8"));
const stable = channels.channels.stable;
const manifestBytes = await readFile(path.join(directory, stable.manifest));
assert.equal(createHash("sha256").update(manifestBytes).digest("hex"), stable.manifestSha256);
const manifest = JSON.parse(manifestBytes);
assert.equal(manifest.taskId, "REL-004");
assert.equal(manifest.release, stable.release);
assert.equal(manifest.channel, "stable");
assert.equal(manifest.images.length, 6);
assert.equal(manifest.artifacts.length, 6);
assert.equal(manifest.rollback.applicationTarget, "1.0.0-rc.1");
assert.equal(manifest.rollback.downMigrations, false);
for (const artifact of manifest.artifacts) {
  const bytes = await readFile(path.join(directory, artifact.path));
  assert.equal(createHash("sha256").update(bytes).digest("hex"), artifact.sha256, artifact.path);
}
console.log(JSON.stringify({ status: "pass", task: "REL-004", release: manifest.release }));
