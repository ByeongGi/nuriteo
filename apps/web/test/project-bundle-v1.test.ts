import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";

import {
  writeValidatedProjectBundleV1,
  type ProjectBundleV1SourceFile
} from "../src/bundles/project-bundle-v1.ts";
import { validateProjectBundleV1Projection } from "../src/bundles/project-bundle-v1-validation.ts";

const decoder = new TextDecoder();
const encoder = new TextEncoder();
const projectId = "0199ee6c-c777-7000-8000-00000000b001";
const storageScopeId = "0199ee6c-c777-7000-8000-00000000b002";
const fixtureFiles: readonly ProjectBundleV1SourceFile[] = [
  {
    path: "src/éxample.ts",
    kind: "text",
    executable: false,
    bytes: encoder.encode("export const greeting = \"안녕 🌱\";\n")
  },
  {
    path: "assets/pixel.bin",
    kind: "binary",
    executable: false,
    bytes: Uint8Array.of(0, 255, 1, 2, 13, 10, 128)
  },
  {
    path: "scripts/start.sh",
    kind: "text",
    executable: true,
    bytes: encoder.encode("#!/bin/sh\nprintf 'ready\\n'\n")
  }
];

const rawFixtureSource = {
  projectId,
  storageScopeId,
  files: fixtureFiles
};
const fixtureSource = validateProjectBundleV1Projection(rawFixtureSource);

const canonical = await writeValidatedProjectBundleV1(fixtureSource);
const reordered = await writeValidatedProjectBundleV1({
  ...fixtureSource,
  files: [fixtureFiles[2]!, fixtureFiles[0]!, fixtureFiles[1]!]
});
assert.deepEqual(reordered.bytes, canonical.bytes, "workspace enumeration order must not affect archive bytes");
assert.deepEqual(reordered.manifest, canonical.manifest);

assert.deepEqual(canonical.manifest, {
  format: "project-bundle-v1",
  schemaVersion: 1,
  project: { id: projectId, storageScopeId },
  fileCount: 3,
  logicalBytes: 73,
  files: [
    {
      path: "assets/pixel.bin",
      kind: "binary",
      mode: "0644",
      sizeBytes: 7,
      sha256: "512bffe697de1f702864e1c8617957784780fc59234667e7674c47912eb0941d"
    },
    {
      path: "scripts/start.sh",
      kind: "text",
      mode: "0755",
      sizeBytes: 27,
      sha256: "1639973df96d58dfeaa125e761bde866d79a0323a146425aaefdeda26845c70f"
    },
    {
      path: "src/éxample.ts",
      kind: "text",
      mode: "0644",
      sizeBytes: 39,
      sha256: "a81cf99a781785ac7685e08f9b3ad4643e215c89ac0faa130eef377665571179"
    }
  ]
});

const archive = parsePaxArchive(canonical.bytes);
assert.equal(archive[0]?.path, "manifest.json", "manifest must be the first archive file");
assert.deepEqual(JSON.parse(decoder.decode(archive[0]?.bytes)), canonical.manifest);
assert.deepEqual(
  archive.slice(1).map(({ path, mode, bytes }) => ({ path, mode, bytes: [...bytes] })),
  [
    { path: "files/assets/pixel.bin", mode: 0o644, bytes: [0, 255, 1, 2, 13, 10, 128] },
    { path: "files/scripts/start.sh", mode: 0o755, bytes: [...encoder.encode("#!/bin/sh\nprintf 'ready\\n'\n")] },
    { path: "files/src/éxample.ts", mode: 0o644, bytes: [...encoder.encode("export const greeting = \"안녕 🌱\";\n")] }
  ]
);

const golden = JSON.parse(
  await readFile(new URL("./fixtures/project-bundle-v1.golden.json", import.meta.url), "utf8")
) as { archiveBytes: number; archiveSha256: string };
assert.equal(canonical.bytes.byteLength, golden.archiveBytes);
assert.equal(createHash("sha256").update(canonical.bytes).digest("hex"), golden.archiveSha256, "canonical archive bytes changed");

await assert.rejects(
  writeValidatedProjectBundleV1({
    ...fixtureSource,
    files: [fixtureFiles[0]!, { ...fixtureFiles[0]!, bytes: Uint8Array.of(1) }]
  }),
  /duplicate path/u
);
await assert.rejects(
  writeValidatedProjectBundleV1({
    ...fixtureSource,
    files: [{ ...fixtureFiles[0]!, path: "src/injected\npath.ts" }]
  }),
  /control character/u
);
await assert.rejects(
  writeValidatedProjectBundleV1({
    ...fixtureSource,
    files: [{ ...fixtureFiles[0]!, path: "src/\ud800.ts" }]
  }),
  /unpaired UTF-16 surrogate/u
);
const utf8Order = await writeValidatedProjectBundleV1({
  ...fixtureSource,
  files: [
    { path: "é.txt", kind: "text", executable: false, bytes: Uint8Array.of() },
    { path: "z.txt", kind: "text", executable: false, bytes: Uint8Array.of() }
  ]
});
assert.deepEqual(utf8Order.manifest.files.map((file) => file.path), ["z.txt", "é.txt"]);

function compileTimeValidatedBoundary(): void {
  // @ts-expect-error BND-002 must brand raw workspace projections before production use.
  void writeValidatedProjectBundleV1(rawFixtureSource);
}
void compileTimeValidatedBoundary;

const productionSources = await readTypeScriptFiles(new URL("../src/", import.meta.url));
for (const source of productionSources) {
  if (
    source.url.endsWith("/bundles/project-bundle-v1.ts")
    || source.url.endsWith("/bundles/project-bundle-v1-validation.ts")
  ) continue;
  if (source.url.endsWith("/save/project-save.ts")) {
    assert.match(source.contents, /validateProjectBundleV1Projection/u);
    assert.match(source.contents, /const projection = projectCurrentTree\(input, currentTree\.files\)/u);
    continue;
  }
  assert.doesNotMatch(
    source.contents,
    /(?:from\s+["'][^"']*project-bundle-v1|writeValidatedProjectBundleV1)/u,
    `production code must not bypass the future BND-002 validator: ${source.url}`
  );
}

interface ParsedFile {
  path: string;
  mode: number;
  bytes: Uint8Array;
}

function parsePaxArchive(bytes: Uint8Array): ParsedFile[] {
  const files: ParsedFile[] = [];
  let offset = 0;
  let paxPath: string | undefined;

  while (offset + 512 <= bytes.byteLength) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const storedChecksum = readOctal(header.subarray(148, 156));
    const checksumHeader = Uint8Array.from(header);
    checksumHeader.fill(0x20, 148, 156);
    assert.equal(checksumHeader.reduce((sum, byte) => sum + byte, 0), storedChecksum);

    const name = readString(header.subarray(0, 100));
    const mode = readOctal(header.subarray(100, 108));
    const size = readOctal(header.subarray(124, 136));
    assert.equal(readOctal(header.subarray(108, 116)), 0, "uid must be normalized");
    assert.equal(readOctal(header.subarray(116, 124)), 0, "gid must be normalized");
    assert.equal(readOctal(header.subarray(136, 148)), 0, "mtime must be normalized");
    assert.equal(readString(header.subarray(257, 263)), "ustar", "POSIX ustar magic required");
    assert.equal(readString(header.subarray(263, 265)), "00");

    const contentOffset = offset + 512;
    const content = bytes.slice(contentOffset, contentOffset + size);
    const type = String.fromCharCode(header[156] ?? 0);
    if (type === "x") {
      paxPath = parsePaxPath(decoder.decode(content));
    } else {
      assert.equal(type, "0");
      files.push({ path: paxPath ?? name, mode, bytes: content });
      paxPath = undefined;
    }
    offset = contentOffset + Math.ceil(size / 512) * 512;
  }

  assert.equal(paxPath, undefined, "pax path must be consumed by a regular file");
  assert.equal(bytes.subarray(offset).every((byte) => byte === 0), true, "archive must end with zero blocks");
  assert.ok(bytes.byteLength - offset >= 1024, "archive must contain two end blocks");
  return files;
}

function parsePaxPath(record: string): string {
  const separator = record.indexOf(" ");
  assert.ok(separator > 0);
  assert.equal(Number(record.slice(0, separator)), encoder.encode(record).byteLength);
  const body = record.slice(separator + 1);
  assert.ok(body.startsWith("path=") && body.endsWith("\n"));
  return body.slice("path=".length, -1);
}

function readString(bytes: Uint8Array): string {
  const end = bytes.indexOf(0);
  return decoder.decode(end === -1 ? bytes : bytes.subarray(0, end));
}

function readOctal(bytes: Uint8Array): number {
  const value = decoder.decode(bytes).replaceAll("\0", "").trim();
  return Number.parseInt(value || "0", 8);
}

async function readTypeScriptFiles(directory: URL): Promise<Array<{ url: string; contents: string }>> {
  const sources: Array<{ url: string; contents: string }> = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const url = new URL(entry.name + (entry.isDirectory() ? "/" : ""), directory);
    if (entry.isDirectory()) {
      sources.push(...await readTypeScriptFiles(url));
    } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
      sources.push({ url: url.pathname, contents: await readFile(url, "utf8") });
    }
  }
  return sources;
}
