#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";

const [reproducibilityPath, outputPath, ...summaryPaths] = process.argv.slice(2);
if (!reproducibilityPath || !outputPath || summaryPaths.length !== 3) {
  throw new Error("usage: merge-security-candidate-reports.mjs REL-001 OUTPUT SERVER WEB OPERATIONS");
}
const reproducibility = JSON.parse(await readFile(reproducibilityPath, "utf8"));
const policy = JSON.parse(await readFile("security/image-release-policy.json", "utf8"));
const summaries = await Promise.all(summaryPaths.map(async (file) => JSON.parse(await readFile(file, "utf8"))));
const roles = new Set();
for (const summary of summaries) {
  if (summary.status !== "PASS" || summary.sourceCommit !== reproducibility.sourceCommit) {
    throw new Error(`invalid security summary: ${summary.role}`);
  }
  if (roles.has(summary.role)) throw new Error(`duplicate security role: ${summary.role}`);
  roles.add(summary.role);
  const candidate = reproducibility.images.find((image) =>
    image.role === summary.role && image.platform === "linux/arm64");
  if (!candidate || candidate.digest !== summary.digest) {
    throw new Error(`security digest is outside REL-001: ${summary.role}`);
  }
}
for (const role of policy.requiredImages) {
  if (!roles.has(role)) throw new Error(`missing security role: ${role}`);
}
const report = {
  schemaVersion: 1,
  taskId: "SEC-004",
  status: "PASS",
  scannedAt: summaries.map(({ scannedAt }) => scannedAt).sort().at(-1),
  sourceCommit: reproducibility.sourceCommit,
  scanner: policy.scanner,
  images: summaries.sort((left, right) => left.role.localeCompare(right.role))
    .map(({ status: _status, scannedAt: _scannedAt, sourceCommit: _sourceCommit, ...image }) => image)
};
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ status: "pass", task: report.taskId, images: report.images.length }));
