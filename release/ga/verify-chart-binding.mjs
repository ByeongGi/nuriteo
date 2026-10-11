#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

const bindingPath = process.argv[2] ?? "release/ga/artifacts/nuriteo-1.0.0.chart-images.json";
const directory = path.dirname(bindingPath);
const binding = JSON.parse(await readFile(bindingPath, "utf8"));
assert.equal(binding.taskId, "REL-003");
assert.equal(binding.version, "1.0.0");
assert.equal(binding.images.length, 6);
const chart = await readFile(path.join(directory, binding.chart.path));
assert.equal(createHash("sha256").update(chart).digest("hex"), binding.chart.sha256);
const keys = new Set(binding.images.map((image) => `${image.role}/${image.platform}`));
for (const platform of ["linux/amd64", "linux/arm64"])
  for (const role of ["server", "web", "operations"])
    assert.ok(keys.has(`${role}/${platform}`), `missing chart image binding: ${role}/${platform}`);
console.log(JSON.stringify({ status: "pass", task: "REL-003", images: binding.images.length }));
