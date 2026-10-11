#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";

const [output, ...inputs] = process.argv.slice(2);
if (!output || inputs.length < 2) {
  throw new Error("usage: merge-reproducible-images.mjs OUTPUT INPUT...");
}

const reports = await Promise.all(
  inputs.map(async (input) => JSON.parse(await readFile(input, "utf8")))
);
const [baseline] = reports;
for (const report of reports) {
  for (const field of ["schemaVersion", "taskId", "status", "version", "sourceCommit", "sourceDateEpoch", "created"]) {
    if (report[field] !== baseline[field]) {
      throw new Error(`${field} mismatch in reproducibility reports`);
    }
  }
}

const expectedRoles = ["server", "web", "operations"];
const expectedPlatforms = ["linux/amd64", "linux/arm64"];
const images = reports
  .flatMap((report) => report.images)
  .sort((left, right) =>
    left.platform.localeCompare(right.platform) || left.role.localeCompare(right.role)
  );

const keys = new Set();
for (const image of images) {
  const key = `${image.role}/${image.platform}`;
  if (keys.has(key)) throw new Error(`duplicate reproducibility result: ${key}`);
  keys.add(key);
  if (!expectedRoles.includes(image.role)) throw new Error(`unexpected image role: ${image.role}`);
  if (!expectedPlatforms.includes(image.platform)) throw new Error(`unexpected platform: ${image.platform}`);
  if (image.passes !== 2) throw new Error(`clean pass count mismatch: ${key}`);
  if (!/^sha256:[0-9a-f]{64}$/u.test(image.digest)) throw new Error(`invalid digest: ${key}`);
}

for (const platform of expectedPlatforms) {
  for (const role of expectedRoles) {
    const key = `${role}/${platform}`;
    if (!keys.has(key)) throw new Error(`missing reproducibility result: ${key}`);
  }
}

const merged = { ...baseline, images };
await writeFile(output, `${JSON.stringify(merged, null, 2)}\n`);
console.log(JSON.stringify({ status: "pass", task: baseline.taskId, images: images.length, output }));
