import {
  ApiError,
  ApiInvalidResponseError,
  ApiResponseTooLargeError,
  ApiTimeoutError,
  ApiTransportError,
  SAVE_MULTIPART_PART_BYTES,
  SAVE_PART_BATCH_LIMIT,
  SAVE_SINGLE_PUT_THRESHOLD_BYTES,
  abortSaveSession,
  completeSaveSession,
  createSaveSession,
  issueSaveParts,
  reconcileSaveSession,
  recordSaveReceipts,
  uploadSaveCapability
} from "@nuriteo/api-client";
import type {
  ApiClient,
  ProjectOwner,
  SavePart,
  SaveUploadCapability,
  SaveUploadReceipt
} from "@nuriteo/api-client";

import { IncrementalSha256 } from "../bundles/incremental-sha256.ts";
import {
  BoundedProjectBundleBlobSink,
  ProjectBundleMultipartSink,
  streamValidatedProjectBundleV1
} from "../bundles/project-bundle-v1.ts";
import type {
  ProjectBundleV1Sink,
  ProjectBundleV1StreamMetadata,
  ValidatedProjectBundleV1Projection
} from "../bundles/project-bundle-v1.ts";
import { validateProjectBundleV1Projection } from "../bundles/project-bundle-v1-validation.ts";
import type { RuntimeBundleFile } from "../runtime/runtime-adapter.ts";

export type ProjectSavePhase = "planning" | "creating" | "uploading" | "committing" | "reconciling";

export interface ProjectSaveProgress {
  readonly phase: ProjectSavePhase;
  readonly uploadedBytes: number;
  readonly totalBytes: number | null;
  readonly uploadedParts: number;
  readonly totalParts: number | null;
}

export interface ProjectSaveInput {
  readonly client: ApiClient;
  readonly csrfToken: string;
  readonly owner: ProjectOwner;
  readonly projectId: string;
  readonly storageScopeId: string;
  readonly projectEtag: string;
  readonly snapshotCurrentTree: () => { readonly revision: number; readonly files: readonly RuntimeBundleFile[] };
  readonly currentRevision: () => number;
  readonly signal?: AbortSignal;
  readonly transferFetch?: typeof globalThis.fetch;
  readonly onProgress?: (progress: ProjectSaveProgress) => void;
}

export interface ProjectSaveResult {
  readonly bundleId: string;
  readonly projectVersion: number;
  readonly projectEtag: string;
  readonly snapshotCurrent: boolean;
  readonly archiveSha256: string;
  readonly physicalBytes: number;
}

interface BundlePlan {
  readonly localRevision: number;
  readonly projection: ValidatedProjectBundleV1Projection;
  readonly metadata: ProjectBundleV1StreamMetadata;
  readonly parts: readonly SavePart[];
}

export async function saveCurrentProject(input: ProjectSaveInput): Promise<ProjectSaveResult> {
  input.onProgress?.(progress("planning"));
  const currentTree = input.snapshotCurrentTree();
  const projection = projectCurrentTree(input, currentTree.files);
  const planner = new BundlePlanningSink(SAVE_MULTIPART_PART_BYTES);
  const planned = await streamValidatedProjectBundleV1(projection, planner, streamOptions(input));
  const plan: BundlePlan = { localRevision: currentTree.revision, projection, metadata: planned, parts: planned.sinkResult };
  const multipart = plan.metadata.physicalBytes > SAVE_SINGLE_PUT_THRESHOLD_BYTES;
  const requestParts = multipart ? plan.parts : [];
  const baseVersion = input.projectEtag.match(/^"project-v([1-9]\d*)"$/u)?.[1];
  if (baseVersion === undefined) throw new Error("The Save base Project ETag is invalid.");
  const idempotencyKey = `bundle-v${baseVersion}-${plan.metadata.archiveSha256}`;
  input.onProgress?.(progress("creating", plan));

  const created = await createSaveSession(input.client, {
    owner: input.owner,
    projectId: input.projectId,
    projectEtag: input.projectEtag,
    idempotencyKey,
    physicalBytes: plan.metadata.physicalBytes,
    logicalBytes: plan.metadata.logicalBytes,
    fileCount: plan.metadata.manifest.fileCount,
    sha256: plan.metadata.archiveSha256,
    parts: requestParts
  }, mutationOptions(input));
  const session = { owner: input.owner, projectId: input.projectId, sessionId: created.data.sessionId };
  let committed = false;
  try {
    input.onProgress?.(progress("uploading", plan));
    if (multipart) {
      await uploadMultipart(input, plan, session);
    } else {
      const sink = new BoundedProjectBundleBlobSink(SAVE_SINGLE_PUT_THRESHOLD_BYTES);
      const streamed = await streamValidatedProjectBundleV1(plan.projection, sink, streamOptions(input));
      assertSamePass(plan, streamed);
      const capability = created.data.upload;
      if (capability === null) throw new Error("The single-upload Save session omitted its capability.");
      const part = {
        partNumber: 1,
        expectedBytes: plan.metadata.physicalBytes,
        sha256: plan.metadata.archiveSha256
      };
      if (capability.transport === "direct") {
        await uploadSaveCapability(capability, part, streamed.sinkResult.blob, transferOptions(input));
      } else {
        await uploadSaveCapability(capability, part, streamed.sinkResult.blob, {
          ...transferOptions(input),
          ...session,
          csrfToken: input.csrfToken,
          uploadMode: "single"
        });
      }
      input.onProgress?.({
        phase: "uploading",
        uploadedBytes: plan.metadata.physicalBytes,
        totalBytes: plan.metadata.physicalBytes,
        uploadedParts: 1,
        totalParts: 1
      });
    }

    input.onProgress?.(progress("committing", plan));
    try {
      const result = await completeSaveSession(input.client, {
        ...session,
        uploadMode: multipart ? "multipart" : "single"
      }, mutationOptions(input));
      committed = true;
      return saveResult(input, plan, result.data.bundleId, result.data.projectVersion, result.projectEtag);
    } catch (error) {
      if (!requiresReconciliation(error)) throw error;
      input.onProgress?.(progress("reconciling", plan));
      const reconciliation = await reconcileSaveSession(input.client, session, { csrfToken: input.csrfToken });
      if (reconciliation.data.state !== "committed") throw error;
      committed = true;
      return saveResult(
        input,
        plan,
        reconciliation.data.bundleId,
        reconciliation.data.projectVersion,
        `"project-v${reconciliation.data.projectVersion}"`
      );
    }
  } catch (error) {
    if (!committed) {
      try { await abortSaveSession(input.client, session, { csrfToken: input.csrfToken }); } catch { /* preserve primary failure */ }
    }
    throw error;
  }
}

async function uploadMultipart(
  input: ProjectSaveInput,
  plan: BundlePlan,
  session: { readonly owner: ProjectOwner; readonly projectId: string; readonly sessionId: string }
): Promise<void> {
  let capabilities: readonly SaveUploadCapability[] = [];
  let capabilityOffset = 0;
  let receipts: SaveUploadReceipt[] = [];
  let uploadedBytes = 0;
  const flushReceipts = async () => {
    if (receipts.length === 0) return;
    await recordSaveReceipts(input.client, { ...session, receipts }, mutationOptions(input));
    receipts = [];
  };
  const sink = new ProjectBundleMultipartSink<void>(
    SAVE_MULTIPART_PART_BYTES,
    async (part) => {
      const expected = plan.parts[part.number - 1];
      if (expected === undefined || expected.expectedBytes !== part.sizeBytes || expected.sha256 !== part.sha256) {
        throw new Error("The second Bundle pass did not match its canonical part plan.");
      }
      if (part.number - 1 >= capabilityOffset + capabilities.length) {
        await flushReceipts();
        capabilityOffset = part.number - 1;
        const batch = plan.parts.slice(capabilityOffset, capabilityOffset + SAVE_PART_BATCH_LIMIT);
        capabilities = (await issueSaveParts(input.client, { ...session, parts: batch }, mutationOptions(input))).data;
      }
      const capability = capabilities[part.number - 1 - capabilityOffset];
      if (capability === undefined) throw new Error("The multipart capability batch was incomplete.");
      const body = new Blob(
        [part.bytes as Uint8Array<ArrayBuffer>],
        { type: "application/vnd.nuriteo.project-bundle" }
      );
      if (capability.transport === "direct") {
        const result = await uploadSaveCapability(capability, expected, body, transferOptions(input));
        receipts.push(result.receipt);
      } else {
        await uploadSaveCapability(capability, expected, body, {
          ...transferOptions(input),
          ...session,
          csrfToken: input.csrfToken,
          uploadMode: "multipart"
        });
      }
      uploadedBytes += part.sizeBytes;
      input.onProgress?.({
        phase: "uploading",
        uploadedBytes,
        totalBytes: plan.metadata.physicalBytes,
        uploadedParts: part.number,
        totalParts: plan.parts.length
      });
      return undefined;
    },
    async () => undefined
  );
  const streamed = await streamValidatedProjectBundleV1(plan.projection, sink, streamOptions(input));
  assertSamePass(plan, streamed);
  await flushReceipts();
}

class BundlePlanningSink implements ProjectBundleV1Sink<readonly SavePart[]> {
  readonly #partBytes: number;
  #digest = new IncrementalSha256();
  #parts: SavePart[] = [];
  #bytes = 0;
  #total = 0;
  #closed = false;

  constructor(partBytes: number) { this.#partBytes = partBytes; }

  async write(bytes: Uint8Array, signal: AbortSignal | undefined): Promise<void> {
    if (this.#closed || signal?.aborted) throw new Error("Bundle planning was aborted.");
    let offset = 0;
    while (offset < bytes.byteLength) {
      const copied = Math.min(this.#partBytes - this.#bytes, bytes.byteLength - offset);
      this.#digest.update(bytes.subarray(offset, offset + copied));
      this.#bytes += copied;
      this.#total += copied;
      offset += copied;
      if (this.#bytes === this.#partBytes) this.#finishPart();
    }
  }

  async complete(metadata: ProjectBundleV1StreamMetadata): Promise<readonly SavePart[]> {
    if (metadata.physicalBytes !== this.#total) throw new Error("Bundle planning byte count changed.");
    if (this.#bytes > 0) this.#finishPart();
    this.#digest.dispose();
    this.#closed = true;
    return Object.freeze([...this.#parts]);
  }

  async abort(): Promise<void> {
    if (!this.#closed) this.#digest.dispose();
    this.#closed = true;
    this.#parts = [];
  }

  #finishPart(): void {
    this.#parts.push({
      partNumber: this.#parts.length + 1,
      expectedBytes: this.#bytes,
      sha256: this.#digest.finishHex()
    });
    this.#digest.dispose();
    this.#digest = new IncrementalSha256();
    this.#bytes = 0;
  }
}

function projectCurrentTree(
  input: ProjectSaveInput,
  currentFiles: readonly RuntimeBundleFile[]
): ValidatedProjectBundleV1Projection {
  const files = currentFiles.map((file) => ({
    path: file.path,
    kind: file.kind,
    executable: false,
    bytes: file.bytes
  }));
  return validateProjectBundleV1Projection({
    projectId: input.projectId,
    storageScopeId: input.storageScopeId,
    files
  });
}

function saveResult(
  input: ProjectSaveInput,
  plan: BundlePlan,
  bundleId: string,
  projectVersion: number,
  projectEtag: string
): ProjectSaveResult {
  return {
    bundleId,
    projectVersion,
    projectEtag,
    snapshotCurrent: input.currentRevision() === plan.localRevision,
    archiveSha256: plan.metadata.archiveSha256,
    physicalBytes: plan.metadata.physicalBytes
  };
}

function requiresReconciliation(error: unknown): boolean {
  return (
    error instanceof ApiTimeoutError ||
    error instanceof ApiTransportError ||
    error instanceof ApiInvalidResponseError ||
    error instanceof ApiResponseTooLargeError ||
    (error instanceof ApiError && (
      error.code === "COMMIT_OUTCOME_UNKNOWN" || error.code === "RECONCILIATION_REQUIRED"
    ))
  );
}

function assertSamePass(plan: BundlePlan, actual: ProjectBundleV1StreamMetadata): void {
  if (
    actual.archiveSha256 !== plan.metadata.archiveSha256 ||
    actual.physicalBytes !== plan.metadata.physicalBytes ||
    actual.logicalBytes !== plan.metadata.logicalBytes ||
    JSON.stringify(actual.manifest) !== JSON.stringify(plan.metadata.manifest)
  ) throw new Error("The second Bundle pass did not match the canonical plan.");
}

function mutationOptions(input: ProjectSaveInput) {
  return { csrfToken: input.csrfToken, ...(input.signal === undefined ? {} : { signal: input.signal }) };
}

function transferOptions(input: ProjectSaveInput) {
  return {
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    ...(input.transferFetch === undefined ? {} : { fetch: input.transferFetch })
  };
}

function streamOptions(input: ProjectSaveInput) {
  return input.signal === undefined ? {} : { signal: input.signal };
}

function progress(phase: ProjectSavePhase, plan?: BundlePlan): ProjectSaveProgress {
  return {
    phase,
    uploadedBytes: 0,
    totalBytes: plan?.metadata.physicalBytes ?? null,
    uploadedParts: 0,
    totalParts: plan?.parts.length ?? null
  };
}
