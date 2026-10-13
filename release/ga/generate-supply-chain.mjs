#!/usr/bin/env node

import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const reportPath = process.argv[2] ?? "release/ga/reproducible-images.json";
const outputDirectory = process.argv[3] ?? "release/ga/artifacts";
const report = JSON.parse(await readFile(reportPath, "utf8"));
if (report.status !== "PASS" || report.images?.length !== 6) {
  throw new Error("complete REL-001 report with six verified images is required");
}

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const cargoLock = await readFile("Cargo.lock", "utf8");
const pnpmLock = await readFile("pnpm-lock.yaml", "utf8");
const cargoPackages = [...cargoLock.matchAll(/^name = "([^"]+)"\nversion = "([^"]+)"/gmu)]
  .map((match) => ({ name: match[1], version: match[2], ecosystem: "cargo" }));
const pnpmPackages = [...pnpmLock.matchAll(/^  (?:'([^']+)'|([^:\n]+)):\s*$/gmu)]
  .map((match) => match[1] ?? match[2])
  .filter((entry) => entry.includes("@"))
  .map((entry) => {
    const separator = entry.lastIndexOf("@");
    return { name: entry.slice(0, separator), version: entry.slice(separator + 1).split("(")[0], ecosystem: "npm" };
  });
const packages = [...cargoPackages, ...pnpmPackages]
  .sort((left, right) => `${left.ecosystem}:${left.name}:${left.version}`.localeCompare(`${right.ecosystem}:${right.name}:${right.version}`));

const namespace = `https://nuriteo.dev/spdx/${report.version}/${report.sourceCommit}`;
const sbom = {
  spdxVersion: "SPDX-2.3",
  dataLicense: "CC0-1.0",
  SPDXID: "SPDXRef-DOCUMENT",
  name: `nuriteo-${report.version}`,
  documentNamespace: namespace,
  creationInfo: { created: report.created, creators: ["Tool: nuriteo-release"] },
  packages: packages.map((component, index) => ({
    SPDXID: `SPDXRef-Package-${index + 1}`,
    name: component.name,
    versionInfo: component.version,
    downloadLocation: "NOASSERTION",
    filesAnalyzed: false,
    licenseConcluded: "NOASSERTION",
    licenseDeclared: "NOASSERTION",
    externalRefs: [{ referenceCategory: "PACKAGE-MANAGER", referenceType: "purl", referenceLocator: `pkg:${component.ecosystem}/${encodeURIComponent(component.name)}@${component.version}` }]
  }))
};
const subjects = report.images.map((image) => ({
  name: `nuriteo-${image.role}:${image.platform}`,
  digest: { sha256: image.digest.slice("sha256:".length) }
}));
const provenance = {
  _type: "https://in-toto.io/Statement/v1",
  subject: subjects,
  predicateType: "https://slsa.dev/provenance/v1",
  predicate: {
    buildDefinition: {
      buildType: "https://nuriteo.dev/build-types/reproducible-oci/v1",
      externalParameters: { version: report.version, sourceDateEpoch: report.sourceDateEpoch },
      internalParameters: { cleanPasses: 2, cacheAllowed: false },
      resolvedDependencies: [
        { uri: `git+https://example.invalid/nuriteo@${report.sourceCommit}`, digest: { gitCommit: report.sourceCommit } },
        { uri: "file:Cargo.lock", digest: { sha256: sha256(cargoLock) } },
        { uri: "file:pnpm-lock.yaml", digest: { sha256: sha256(pnpmLock) } }
      ]
    },
    runDetails: { builder: { id: "https://github.com/nuriteo/release-workflow" }, metadata: { invocationId: report.sourceCommit } }
  }
};

await mkdir(outputDirectory, { recursive: true });
const copiedReportPath = path.join(outputDirectory, "reproducible-images.json");
await copyFile(reportPath, copiedReportPath);
const sbomPath = path.join(outputDirectory, `nuriteo-${report.version}.spdx.json`);
const provenancePath = path.join(outputDirectory, `nuriteo-${report.version}.intoto.jsonl`);
await writeFile(sbomPath, `${JSON.stringify(sbom, null, 2)}\n`);
await writeFile(provenancePath, `${JSON.stringify(provenance)}\n`);
const checksumInputs = [copiedReportPath, sbomPath, provenancePath].sort();
const checksums = [];
for (const input of checksumInputs) checksums.push(`${sha256(await readFile(input))}  ${path.basename(input)}`);
await writeFile(path.join(outputDirectory, "SHA256SUMS"), `${checksums.join("\n")}\n`);
console.log(JSON.stringify({ status: "pass", task: "REL-002", packages: packages.length, subjects: subjects.length }));
