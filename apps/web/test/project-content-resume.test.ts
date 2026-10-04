import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { validateProjectBundleV1Projection } from "../src/bundles/project-bundle-v1-validation.ts";
import { writeValidatedProjectBundleV1 } from "../src/bundles/project-bundle-v1.ts";
import {
  MAX_RESUME_PHYSICAL_BYTES,
  ProjectContentError,
  resumeProjectContent
} from "../src/resume/project-content.ts";

const ownerId = "0199ee6c-c777-7000-8000-00000000d001";
const projectId = "0199ee6c-c777-7000-8000-00000000d002";
const bundleId = "0199ee6c-c777-7000-8000-00000000d003";
const storageScopeId = "0199ee6c-c777-7000-8000-00000000d004";
const contentPath = `/api/v1/workspaces/users/${ownerId}/projects/${projectId}/content`;
const downloadUrl = `${contentPath}/${bundleId}`;
const source = validateProjectBundleV1Projection({
  projectId,
  storageScopeId,
  files: [
    { path: "package.json", kind: "text", executable: false, bytes: bytes("{\"scripts\":{\"dev\":\"vite\"}}\n") },
    { path: "src/main.tsx", kind: "text", executable: false, bytes: bytes("export default function App() { return 'restored'; }\n") }
  ]
});
const archive = await writeValidatedProjectBundleV1(source);
const checksum = sha256Base64Url(archive.bytes);
const etag = `"content-v7-${checksum}"`;

await resumesVerifiedCurrentHead();
await retriesOneStaleDescriptor();
await resumesCanonicalEmptyBundle();
await rejectsOuterChecksumMismatch();
await rejectsInnerChecksumMismatchEvenWithMatchingOuterDigest();
await rejectsNonCanonicalTarHeaderEvenWithMatchingOuterDigest();
await rejectsNonZeroTarPaddingEvenWithMatchingOuterDigest();
await rejectsUnsafeDescriptorAndLimit();

async function resumesVerifiedCurrentHead(): Promise<void> {
  const requests: Array<{ headers: Headers; url: string }> = [];
  const result = await resumeProjectContent(identity(), {
    fetch: async (input, init) => {
      requests.push({ headers: new Headers(init?.headers), url: String(input) });
      return String(input) === contentPath
        ? descriptorResponse(descriptor())
        : bundleResponse(archive.bytes, descriptor());
    }
  });
  assert.equal(result.descriptor.projectVersion, 7);
  assert.deepEqual(result.files.map((file) => file.path), ["package.json", "src/main.tsx"]);
  assert.match(new TextDecoder().decode(result.files[1]?.bytes), /restored/u);
  assert.deepEqual(requests.map((request) => request.url), [contentPath, downloadUrl]);
  assert.equal(requests[1]?.headers.get("if-match"), etag);
  assert.equal(requests[1]?.headers.get("authorization"), null);
}

async function retriesOneStaleDescriptor(): Promise<void> {
  let descriptors = 0;
  let downloads = 0;
  const result = await resumeProjectContent(identity(), {
    fetch: async (input) => {
      if (String(input) === contentPath) {
        descriptors += 1;
        return descriptorResponse(descriptor());
      }
      downloads += 1;
      return downloads === 1
        ? new Response(null, { status: 412 })
        : bundleResponse(archive.bytes, descriptor());
    }
  });
  assert.equal(result.files.length, 2);
  assert.equal(descriptors, 2);
  assert.equal(downloads, 2);
}

async function resumesCanonicalEmptyBundle(): Promise<void> {
  const emptyArchive = await writeValidatedProjectBundleV1(validateProjectBundleV1Projection({
    projectId,
    storageScopeId,
    files: []
  }));
  const emptyChecksum = sha256Base64Url(emptyArchive.bytes);
  const emptyDescriptor = descriptor({
    checksum: emptyChecksum,
    physicalBytes: emptyArchive.bytes.byteLength,
    logicalBytes: 0,
    fileCount: 0
  });
  const result = await resumeProjectContent(identity(), {
    fetch: responseSequence(
      descriptorResponse(emptyDescriptor),
      bundleResponse(emptyArchive.bytes, emptyDescriptor)
    )
  });
  assert.deepEqual(result.files, []);
  assert.equal(result.descriptor.fileCount, 0);
}

async function rejectsOuterChecksumMismatch(): Promise<void> {
  const corrupted = Uint8Array.from(archive.bytes);
  corrupted[corrupted.byteLength - 1] = 1;
  await expectCode(() => resumeProjectContent(identity(), {
    fetch: responseSequence(descriptorResponse(descriptor()), bundleResponse(corrupted, descriptor()))
  }), "RESUME_INTEGRITY_FAILED");
}

async function rejectsInnerChecksumMismatchEvenWithMatchingOuterDigest(): Promise<void> {
  const corrupted = Uint8Array.from(archive.bytes);
  const markerOffset = indexOf(corrupted, bytes("restored"));
  assert.ok(markerOffset >= 0);
  corrupted[markerOffset] = "R".charCodeAt(0);
  const changed = descriptor({ checksum: sha256Base64Url(corrupted) });
  await expectCode(() => resumeProjectContent(identity(), {
    fetch: responseSequence(descriptorResponse(changed), bundleResponse(corrupted, changed))
  }), "RESUME_INTEGRITY_FAILED");
}

async function rejectsNonCanonicalTarHeaderEvenWithMatchingOuterDigest(): Promise<void> {
  const corrupted = Uint8Array.from(archive.bytes);
  corrupted[157] = 1;
  rewriteTarChecksum(corrupted, 0);
  const changed = descriptor({ checksum: sha256Base64Url(corrupted) });
  await expectCode(() => resumeProjectContent(identity(), {
    fetch: responseSequence(descriptorResponse(changed), bundleResponse(corrupted, changed))
  }), "RESUME_INTEGRITY_FAILED");
}

async function rejectsNonZeroTarPaddingEvenWithMatchingOuterDigest(): Promise<void> {
  const corrupted = Uint8Array.from(archive.bytes);
  const manifestBytes = bytes(`${JSON.stringify(archive.manifest)}\n`).byteLength;
  const firstPaddingByte = 512 + manifestBytes;
  assert.notEqual(firstPaddingByte % 512, 0);
  corrupted[firstPaddingByte] = 1;
  const changed = descriptor({ checksum: sha256Base64Url(corrupted) });
  await expectCode(() => resumeProjectContent(identity(), {
    fetch: responseSequence(descriptorResponse(changed), bundleResponse(corrupted, changed))
  }), "RESUME_INTEGRITY_FAILED");
}

async function rejectsUnsafeDescriptorAndLimit(): Promise<void> {
  await expectCode(() => resumeProjectContent(identity(), {
    fetch: async () => descriptorResponse(descriptor({ downloadUrl: "https://storage.invalid/object" }))
  }), "RESUME_DESCRIPTOR_INVALID");
  await expectCode(() => resumeProjectContent(identity(), {
    fetch: async () => descriptorResponse(descriptor({ physicalBytes: MAX_RESUME_PHYSICAL_BYTES + 1 }))
  }), "RESUME_LIMIT_EXCEEDED");
}

function identity() { return { ownerType: "user" as const, ownerId, projectId, storageScopeId }; }

function descriptor(overrides: Record<string, unknown> = {}) {
  const nextChecksum = typeof overrides.checksum === "string" ? overrides.checksum : checksum;
  return {
    projectId, projectVersion: 7, bundleId,
    etag: `"content-v7-${nextChecksum}"`, checksumAlgorithm: "sha-256", checksum: nextChecksum,
    physicalBytes: archive.bytes.byteLength, logicalBytes: archive.manifest.logicalBytes,
    fileCount: archive.manifest.fileCount, format: "project-bundle-v1", downloadUrl,
    ...overrides
  };
}

function descriptorResponse(value: unknown): Response {
  return Response.json(value, { headers: { "cache-control": "private, no-store" } });
}

function bundleResponse(value: Uint8Array, metadata: ReturnType<typeof descriptor>): Response {
  const midpoint = Math.floor(value.byteLength / 2);
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(value.slice(0, midpoint));
      controller.enqueue(value.slice(midpoint));
      controller.close();
    }
  });
  return new Response(body, { headers: {
    "cache-control": "private, no-store", "content-length": String(value.byteLength),
    "content-type": "application/octet-stream", etag: String(metadata.etag),
    "x-content-type-options": "nosniff"
  } });
}

function responseSequence(...responses: Response[]): typeof fetch {
  let index = 0;
  return async () => responses[index++] ?? new Response(null, { status: 500 });
}

async function expectCode(action: () => Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(action, (error: unknown) => error instanceof ProjectContentError && error.code === code);
}

function bytes(value: string): Uint8Array { return new TextEncoder().encode(value); }
function sha256Base64Url(value: Uint8Array): string { return createHash("sha256").update(value).digest("base64url"); }
function indexOf(haystack: Uint8Array, needle: Uint8Array): number {
  outer: for (let offset = 0; offset <= haystack.byteLength - needle.byteLength; offset += 1) {
    for (let index = 0; index < needle.byteLength; index += 1) {
      if (haystack[offset + index] !== needle[index]) continue outer;
    }
    return offset;
  }
  return -1;
}

function rewriteTarChecksum(bytes: Uint8Array, headerOffset: number): void {
  const header = bytes.subarray(headerOffset, headerOffset + 512);
  header.fill(0x20, 148, 156);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.set(new TextEncoder().encode(checksum.toString(8).padStart(6, "0")), 148);
  header[154] = 0;
  header[155] = 0x20;
}
