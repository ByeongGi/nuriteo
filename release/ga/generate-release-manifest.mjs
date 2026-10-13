#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const reportPath = process.argv[2] ?? "release/ga/reproducible-images.json";
const directory = process.argv[3] ?? "release/ga/artifacts";
const report = JSON.parse(await readFile(reportPath, "utf8"));
if (report.status !== "PASS" || report.images?.length !== 6) throw new Error("complete REL-001 report required");
const hashFile = async (file) => createHash("sha256").update(await readFile(file)).digest("hex");
const definitions = [
  ["sbom", `nuriteo-${report.version}.spdx.json`],
  ["provenance", `nuriteo-${report.version}.intoto.jsonl`],
  ["checksums", "SHA256SUMS"],
  ["checksum-signature", "SHA256SUMS.sig"],
  ["helm-chart", `nuriteo-${report.version}.tgz`],
  ["chart-image-binding", `nuriteo-${report.version}.chart-images.json`]
];
const artifacts = [];
for (const [kind, name] of definitions) artifacts.push({ kind, path: name, sha256: await hashFile(path.join(directory, name)) });
const manifest = {
  schemaVersion: 1,
  taskId: "REL-004",
  releaseLineage: "nuriteo-self-hosted-v1",
  release: report.version,
  channel: "stable",
  sourceCommit: report.sourceCommit,
  created: report.created,
  images: report.images,
  artifacts,
  compatibility: {
    kubernetes: ">=1.29.0-0",
    sourceMatrix: "compat/self-hosted-v1-lifecycle-matrix.json",
    supportMatrix: "support/self-hosted-v1-support-matrix.json"
  },
  rollback: {
    applicationTarget: "1.0.0-rc.1",
    database: "restore-pre-upgrade-backup-only",
    downMigrations: false
  }
};
const manifestPath = path.join(directory, `nuriteo-${report.version}.release.json`);
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
const manifestSha256 = await hashFile(manifestPath);
const channels = {
  schemaVersion: 1,
  channels: { stable: { release: report.version, manifest: path.basename(manifestPath), manifestSha256 } }
};
await writeFile(path.join(directory, "channels.json"), `${JSON.stringify(channels, null, 2)}\n`);
const releaseChecksums = [manifestPath, path.join(directory, "channels.json")];
const releaseChecksumLines = [];
for (const file of releaseChecksums.sort()) releaseChecksumLines.push(`${await hashFile(file)}  ${path.basename(file)}`);
await writeFile(path.join(directory, "RELEASE-SHA256SUMS"), `${releaseChecksumLines.join("\n")}\n`);
console.log(JSON.stringify({ status: "pass", task: "REL-004", release: report.version, manifestSha256 }));
