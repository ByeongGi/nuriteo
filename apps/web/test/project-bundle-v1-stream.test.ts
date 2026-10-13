import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import {
  BoundedProjectBundleBlobSink,
  PROJECT_BUNDLE_MULTIPART_MAX_BYTES,
  PROJECT_BUNDLE_MULTIPART_MAX_PART_BYTES,
  PROJECT_BUNDLE_MULTIPART_MAX_PARTS,
  PROJECT_BUNDLE_MULTIPART_MIN_PART_BYTES,
  ProjectBundleMultipartSink,
  planProjectBundleMultipart,
  streamValidatedProjectBundleV1,
  writeValidatedProjectBundleV1,
  type ProjectBundleV1Sink,
  type ProjectBundleV1SourceFile,
  type ProjectBundleV1StreamMetadata,
  type ValidatedProjectBundleV1Projection
} from "../src/bundles/project-bundle-v1.ts";

const encoder = new TextEncoder();
const mebibyte = 1024 * 1024;
const projectId = "0199ee6c-c777-7000-8000-00000000b001";
const storageScopeId = "0199ee6c-c777-7000-8000-00000000b002";

const goldenFiles: readonly ProjectBundleV1SourceFile[] = [
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

const goldenSource = validated(goldenFiles);
const canonical = await writeValidatedProjectBundleV1(goldenSource);
const blobResult = await streamValidatedProjectBundleV1(
  goldenSource,
  new BoundedProjectBundleBlobSink(mebibyte),
  { chunkBytes: 7 }
);
const streamedBytes = new Uint8Array(await blobResult.sinkResult.blob.arrayBuffer());
assert.deepEqual(streamedBytes, canonical.bytes, "streaming must preserve every BND-001 golden byte");
assert.deepEqual(blobResult.manifest, canonical.manifest);
assert.equal(blobResult.physicalBytes, canonical.bytes.byteLength);
assert.equal(blobResult.logicalBytes, canonical.manifest.logicalBytes);
assert.equal(blobResult.archiveSha256, sha256(canonical.bytes));
assert.equal(blobResult.peakChunkBytes, 7);
assert.equal(blobResult.sinkResult.peakBufferedBytes, canonical.bytes.byteLength);

const golden = JSON.parse(
  await readFile(new URL("./fixtures/project-bundle-v1.golden.json", import.meta.url), "utf8")
) as { archiveBytes: number; archiveSha256: string };
assert.equal(blobResult.physicalBytes, golden.archiveBytes);
assert.equal(blobResult.archiveSha256, golden.archiveSha256);

assert.deepEqual(
  planProjectBundleMultipart(
    PROJECT_BUNDLE_MULTIPART_MIN_PART_BYTES * PROJECT_BUNDLE_MULTIPART_MAX_PARTS,
    PROJECT_BUNDLE_MULTIPART_MIN_PART_BYTES
  ),
  { partCount: 128, finalPartBytes: PROJECT_BUNDLE_MULTIPART_MIN_PART_BYTES }
);
assert.throws(
  () => planProjectBundleMultipart(
    PROJECT_BUNDLE_MULTIPART_MIN_PART_BYTES * PROJECT_BUNDLE_MULTIPART_MAX_PARTS + 1,
    PROJECT_BUNDLE_MULTIPART_MIN_PART_BYTES
  ),
  /128-part/u
);
assert.throws(
  () => planProjectBundleMultipart(mebibyte, PROJECT_BUNDLE_MULTIPART_MIN_PART_BYTES - 1),
  /part size/u
);
assert.throws(
  () => planProjectBundleMultipart(
    PROJECT_BUNDLE_MULTIPART_MAX_BYTES + 1,
    PROJECT_BUNDLE_MULTIPART_MAX_PART_BYTES
  ),
  /128-part/u
);

const crossBoundarySource = validated([
  binaryFile("a.bin", 3 * mebibyte, 0x31),
  binaryFile("b.bin", 3 * mebibyte, 0x42)
]);
const crossBoundaryCanonical = await writeValidatedProjectBundleV1(crossBoundarySource);
const uploadedParts: Uint8Array[] = [];
const firstUploadStarted = deferred<void>();
const releaseFirstUpload = deferred<void>();
let uploadsInFlight = 0;
let peakUploadsInFlight = 0;
let uploadAborted = false;
const multipart = new ProjectBundleMultipartSink(
  PROJECT_BUNDLE_MULTIPART_MIN_PART_BYTES,
  async (part) => {
    uploadsInFlight += 1;
    peakUploadsInFlight = Math.max(peakUploadsInFlight, uploadsInFlight);
    if (part.number === 1) {
      firstUploadStarted.resolve();
      await releaseFirstUpload.promise;
    }
    uploadedParts.push(Uint8Array.from(part.bytes));
    assert.equal(part.sha256, sha256(part.bytes));
    uploadsInFlight -= 1;
    return `etag-${part.number}`;
  },
  async () => { uploadAborted = true; }
);
let multipartSettled = false;
const multipartPromise = streamValidatedProjectBundleV1(
  crossBoundarySource,
  multipart,
  { chunkBytes: 32 * 1024 }
).finally(() => { multipartSettled = true; });
await firstUploadStarted.promise;
await Promise.resolve();
assert.equal(multipartSettled, false, "writer must await sink backpressure");
assert.equal(uploadedParts.length, 0, "the blocked upload must not be observed as completed");
releaseFirstUpload.resolve();
const multipartResult = await multipartPromise;
assert.equal(uploadAborted, false);
assert.equal(peakUploadsInFlight, 1, "parts must not bypass the bounded upload queue");
assert.equal(multipartResult.sinkResult.parts.length, 2);
assert.equal(multipartResult.sinkResult.parts[0]?.sizeBytes, PROJECT_BUNDLE_MULTIPART_MIN_PART_BYTES);
assert.ok((multipartResult.sinkResult.parts[1]?.sizeBytes ?? 0) < PROJECT_BUNDLE_MULTIPART_MIN_PART_BYTES);
assert.deepEqual(concatenate(uploadedParts), crossBoundaryCanonical.bytes);

let abortCalls = 0;
let completeCalls = 0;
const failingSink: ProjectBundleV1Sink<never> = {
  async write() {
    throw new Error("fixture sink failure");
  },
  async complete() {
    completeCalls += 1;
    throw new Error("unexpected complete");
  },
  async abort() {
    abortCalls += 1;
  }
};
await assert.rejects(streamValidatedProjectBundleV1(goldenSource, failingSink), /fixture sink failure/u);
assert.equal(abortCalls, 1, "sink failures must invoke abort exactly once");
assert.equal(completeCalls, 0, "partial archives must never complete successfully");

const controller = new AbortController();
controller.abort();
let cancellationAbortCalls = 0;
await assert.rejects(
  streamValidatedProjectBundleV1(goldenSource, {
    async write() {},
    async complete() {},
    async abort() { cancellationAbortCalls += 1; }
  }, { signal: controller.signal }),
  /was aborted/u
);
assert.equal(cancellationAbortCalls, 1, "caller cancellation must release the sink");

const midFlightController = new AbortController();
const blockedUploadStarted = deferred<void>();
let midFlightAbortCalls = 0;
let midFlightCompleted = false;
const blockedMultipart = new ProjectBundleMultipartSink(
  PROJECT_BUNDLE_MULTIPART_MIN_PART_BYTES,
  async (part) => {
    blockedUploadStarted.resolve();
    await rejectsWhenAborted(part.signal);
    return "unreachable-etag";
  },
  async () => { midFlightAbortCalls += 1; }
);
const midFlight = streamValidatedProjectBundleV1(
  crossBoundarySource,
  blockedMultipart,
  { signal: midFlightController.signal }
).then(() => { midFlightCompleted = true; });
await blockedUploadStarted.promise;
midFlightController.abort();
await assert.rejects(midFlight, /upload was aborted/u);
assert.equal(midFlightCompleted, false, "mid-flight cancellation must not return a partial result");
assert.equal(midFlightAbortCalls, 1, "settled cancelled upload must then abort multipart state");

let failedUploadAbortCalls = 0;
const doublyFailingMultipart = new ProjectBundleMultipartSink(
  PROJECT_BUNDLE_MULTIPART_MIN_PART_BYTES,
  async () => { throw new Error("upload failed"); },
  async () => {
    failedUploadAbortCalls += 1;
    throw new Error("abort upload failed");
  }
);
await assert.rejects(
  streamValidatedProjectBundleV1(crossBoundarySource, doublyFailingMultipart),
  (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.match(String(error.errors[0]), /upload failed/u);
    assert.match(String(error.errors[1]), /abort upload failed/u);
    return true;
  }
);
assert.equal(failedUploadAbortCalls, 1);

const changingBytes = new Uint8Array(96 * 1024).fill(0x5a);
let changed = false;
let changedSourceAborted = false;
const mutationSink: ProjectBundleV1Sink<void> = {
  async write() {
    if (!changed) {
      changed = true;
      changingBytes.fill(0xa5);
    }
  },
  async complete() {},
  async abort() { changedSourceAborted = true; }
};
await assert.rejects(
  streamValidatedProjectBundleV1(validated([{
    path: "changing.bin",
    kind: "binary",
    executable: false,
    bytes: changingBytes
  }]), mutationSink),
  /source changed/u
);
assert.equal(changedSourceAborted, true, "source mutation must abort the partial sink");

// Exercise the 256 MiB absolute Project source ceiling without retaining the
// generated archive. The multipart sink owns exactly one 5 MiB part buffer and
// the writer presents at most one 64 KiB view, regardless of source size.
const absoluteSourceBytes = 256 * mebibyte;
const maximumSource = validated([binaryFile("maximum.bin", absoluteSourceBytes, 0x6d)]);
let maximumPartCount = 0;
const maximumMultipart = new ProjectBundleMultipartSink(
  PROJECT_BUNDLE_MULTIPART_MIN_PART_BYTES,
  async (part) => {
    maximumPartCount += 1;
    return part.sha256;
  },
  async () => { throw new Error("maximum source fixture must not abort"); }
);
const maximumResult = await streamValidatedProjectBundleV1(maximumSource, maximumMultipart);
assert.equal(maximumResult.logicalBytes, absoluteSourceBytes);
assert.equal(maximumResult.sinkResult.parts.length, maximumPartCount);
assert.equal(maximumResult.sinkResult.parts.length, 52);
assert.ok((maximumResult.sinkResult.parts.at(-1)?.sizeBytes ?? 0) < PROJECT_BUNDLE_MULTIPART_MIN_PART_BYTES);
assert.equal(maximumResult.sinkResult.peakBufferedBytes, PROJECT_BUNDLE_MULTIPART_MIN_PART_BYTES);
assert.ok(maximumResult.peakChunkBytes <= 64 * 1024);
assert.ok(
  maximumResult.sinkResult.peakBufferedBytes + maximumResult.peakChunkBytes <=
    PROJECT_BUNDLE_MULTIPART_MIN_PART_BYTES + 64 * 1024,
  "retained archive bytes must remain within the configured part plus chunk ceiling"
);

function validated(files: readonly ProjectBundleV1SourceFile[]): ValidatedProjectBundleV1Projection {
  return { projectId, storageScopeId, files } as unknown as ValidatedProjectBundleV1Projection;
}

function binaryFile(path: string, size: number, byte: number): ProjectBundleV1SourceFile {
  return { path, kind: "binary", executable: false, bytes: new Uint8Array(size).fill(byte) };
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function concatenate(chunks: readonly Uint8Array[]): Uint8Array {
  const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function deferred<T>(): { promise: Promise<T>; resolve(value?: T): void } {
  let resolvePromise!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolve) => { resolvePromise = resolve; });
  return { promise, resolve: (value) => resolvePromise(value as T) };
}

async function rejectsWhenAborted(signal: AbortSignal | undefined): Promise<never> {
  if (signal === undefined) throw new Error("fixture upload requires an abort signal");
  if (!signal.aborted) {
    await new Promise<void>((resolve) => {
      signal.addEventListener("abort", () => resolve(), { once: true });
    });
  }
  throw new Error("upload was aborted");
}

void ({} as ProjectBundleV1StreamMetadata);
