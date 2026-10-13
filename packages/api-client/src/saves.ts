import { mutationOptions } from "./browser-mutation.ts";
import { validateHeaderValue } from "./browser-mutation.ts";
import type { BrowserMutationOptions } from "./browser-mutation.ts";
import {
  type ApiEmptyResult,
  type ApiResult,
  type DomainRequestOptions,
  invalidResponse,
  requireNoContent,
  validatedResult
} from "./domain.ts";
import {
  ApiAbortError,
  ApiConfigurationError,
  ApiError,
  ApiInvalidResponseError,
  ApiTimeoutError
} from "./errors.ts";
import { IncrementalSha256 } from "./incremental-sha256.ts";
import type { ProjectOwner } from "./projects.ts";
import type {
  ApiClient,
  ApiResponse,
  FieldViolation,
  ProblemDetails
} from "./types.ts";
import {
  readBoolean,
  readBoundedArray,
  readBoundedString,
  readExactRecord,
  readPositiveInteger,
  readUtcTimestamp,
  readUuidV7
} from "./validation.ts";

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const PROJECT_ETAG = /^"project-v([1-9]\d*)"$/u;
const CONTENT_ETAG = /^"content-v([1-9]\d*)-([A-Za-z0-9_-]{43})"$/u;
const SHA256_HEX = /^[0-9a-f]{64}$/u;
const SHA256_BASE64URL = /^[A-Za-z0-9_-]{43}$/u;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._-]{16,128}$/u;
const MAX_PROJECT_VERSION = 9_007_199_254_740_991;
const MAX_TRANSFER_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_UPLOAD_HEADERS = 16;
const MAX_HEADER_BYTES = 8_192;
const MAX_CAPABILITY_URL_BYTES = 16_384;
const MAX_CAPABILITY_PATH_BYTES = 2_048;
const MAX_PROBLEM_BYTES = 64 * 1024;
const encoder = new TextEncoder();

export const SAVE_SINGLE_PUT_THRESHOLD_BYTES = 64 * 1024 * 1024;
export const SAVE_MULTIPART_PART_BYTES = 16 * 1024 * 1024;
export const SAVE_MAX_PARTS = 128;
export const SAVE_PART_BATCH_LIMIT = 16;
export const DEFAULT_PROJECT_TRANSFER_TIMEOUT_MS = 120_000;
export const MAX_PROJECT_TRANSFER_TIMEOUT_MS = 600_000;
export const DEFAULT_PROJECT_CONTENT_MAX_BYTES = 300 * 1024 * 1024;

const BUNDLE_CONTENT_TYPE = "application/vnd.nuriteo.project-bundle";
const DIRECT_UPLOAD_HEADERS = new Set([
  "content-length",
  "content-type",
  "host",
  "x-amz-checksum-sha256",
  "x-amz-sdk-checksum-algorithm"
]);
const RELAY_UPLOAD_HEADERS = new Set([
  "content-type",
  "x-nuriteo-content-sha256"
]);
const BROWSER_MANAGED_UPLOAD_HEADERS = new Set(["content-length", "host"]);

export interface SaveProjectInput {
  readonly owner: ProjectOwner;
  readonly projectId: string;
}

export interface SavePart {
  readonly partNumber: number;
  readonly expectedBytes: number;
  /** Lowercase hexadecimal SHA-256 from the Bundle streaming boundary. */
  readonly sha256: string;
}

export interface CreateSaveSessionInput extends SaveProjectInput {
  readonly projectEtag: string;
  readonly idempotencyKey: string;
  readonly physicalBytes: number;
  readonly logicalBytes: number;
  readonly fileCount: number;
  /** Lowercase hexadecimal SHA-256 from the Bundle streaming boundary. */
  readonly sha256: string;
  readonly parts?: readonly SavePart[];
}

export interface SaveSessionInput extends SaveProjectInput {
  readonly sessionId: string;
}

export interface SaveUploadHeader {
  readonly name: string;
  readonly value: string;
}

export interface DirectSaveUploadCapability {
  readonly transport: "direct";
  readonly method: "PUT";
  /** Ephemeral bearer URL. Never persist or include it in diagnostics. */
  readonly url: string;
  readonly headers: readonly SaveUploadHeader[];
  readonly expectedBytes: number;
}

export interface RelaySaveUploadCapability {
  readonly transport: "relay";
  readonly method: "PUT";
  /** Canonical same-origin path. It never contains a storage credential. */
  readonly path: `/${string}`;
  readonly headers: readonly SaveUploadHeader[];
  readonly expectedBytes: number;
}

export type SaveUploadCapability =
  | DirectSaveUploadCapability
  | RelaySaveUploadCapability;

export interface SaveSession {
  readonly sessionId: string;
  readonly uploadMode: "single" | "multipart";
  readonly expiresAt: string;
  readonly partCount: number;
  readonly idempotentRetry: boolean;
  readonly upload: SaveUploadCapability | null;
}

export interface SaveSessionResult extends ApiResult<SaveSession> {
  readonly replayed: boolean;
}

export interface IssueSavePartsInput extends SaveSessionInput {
  readonly parts: readonly SavePart[];
}

export interface SaveUploadReceipt extends SavePart {
  readonly etag: string;
}

export interface RecordSaveReceiptsInput extends SaveSessionInput {
  readonly receipts: readonly SaveUploadReceipt[];
}

export type SaveUploadMode = "single" | "multipart";

export interface CompleteSaveSessionInput extends SaveSessionInput {
  readonly uploadMode: SaveUploadMode;
}

export interface SaveCommit {
  readonly bundleId: string;
  readonly projectVersion: number;
}

export interface SaveCommitResult extends ApiResult<SaveCommit> {
  readonly projectEtag: string;
}

export type SaveReconciliation =
  | { readonly state: "committed"; readonly bundleId: string; readonly projectVersion: number }
  | { readonly state: "notCommitted" };

export interface ProjectContentDescriptor {
  readonly projectId: string;
  readonly projectVersion: number;
  readonly bundleId: string;
  readonly etag: string;
  readonly checksumAlgorithm: "sha-256";
  readonly checksum: string;
  readonly physicalBytes: number;
  readonly logicalBytes: number;
  readonly fileCount: number;
  readonly format: "project-bundle-v1";
  readonly downloadUrl: string;
}

export interface ProjectContentDescriptorResult extends ApiResult<ProjectContentDescriptor> {
  readonly etag: string;
}

export type ProjectTransferPhase = "upload" | "download";
export type ProjectTransferErrorKind =
  | "aborted"
  | "timeout"
  | "transport"
  | "rejected"
  | "invalid-response"
  | "too-large"
  | "integrity"
  | "sink";

export class ProjectTransferError extends Error {
  readonly phase: ProjectTransferPhase;
  readonly kind: ProjectTransferErrorKind;
  readonly status: number | undefined;
  readonly retryable: boolean;

  constructor(
    phase: ProjectTransferPhase,
    kind: ProjectTransferErrorKind,
    options: { readonly status?: number; readonly retryable?: boolean } = {}
  ) {
    super(projectTransferMessage(phase, kind));
    this.name = "ProjectTransferError";
    this.phase = phase;
    this.kind = kind;
    this.status = options.status;
    this.retryable = options.retryable ?? false;
  }
}

export interface TransferRequestOptions {
  readonly fetch?: typeof globalThis.fetch;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export interface RelayUploadIdentity extends SaveSessionInput {
  readonly csrfToken: string;
  readonly uploadMode: SaveUploadMode;
}

export type UploadSaveCapabilityOptions<
  Capability extends SaveUploadCapability = SaveUploadCapability
> = [Capability] extends [DirectSaveUploadCapability]
  ? TransferRequestOptions
  : TransferRequestOptions & RelayUploadIdentity;

export interface DirectSaveUploadResult {
  readonly transport: "direct";
  readonly receipt: SaveUploadReceipt;
}

export interface RelaySaveUploadResult {
  readonly transport: "relay";
}

export type SaveUploadResult<Capability extends SaveUploadCapability = SaveUploadCapability> =
  Capability extends DirectSaveUploadCapability
    ? DirectSaveUploadResult
    : RelaySaveUploadResult;

export interface DownloadProjectContentOptions<Result> extends TransferRequestOptions {
  readonly baseUrl?: string;
  readonly credentials?: RequestCredentials;
  readonly maxBytes?: number;
  readonly sink: ProjectContentSink<Result>;
}

/** The chunk passed to write is borrowed only until the returned promise settles. */
export interface ProjectContentSink<Result> {
  write(chunk: Uint8Array, signal: AbortSignal | undefined): Promise<void>;
  complete(
    descriptor: ProjectContentDescriptor,
    signal: AbortSignal | undefined
  ): Promise<Result>;
  abort(reason: ProjectTransferError): Promise<void>;
}

export interface ProjectContentDownloadResult<Result> {
  readonly descriptor: ProjectContentDescriptor;
  readonly sinkResult: Result;
  readonly receivedBytes: number;
}

export async function createSaveSession(
  client: ApiClient,
  input: CreateSaveSessionInput,
  options: BrowserMutationOptions
): Promise<SaveSessionResult> {
  const context = saveContext(input);
  const projectEtag = validateProjectEtag(input.projectEtag);
  const idempotencyKey = validateIdempotencyKey(input.idempotencyKey);
  const physicalBytes = readTransferSize(input.physicalBytes, "physical byte count", false);
  const logicalBytes = readTransferSize(input.logicalBytes, "logical byte count", true);
  const fileCount = readCount(input.fileCount, 100_000, "file count", true);
  const bundleChecksum = hexToBase64(validateSha256Hex(input.sha256));
  const parts = validateParts(input.parts ?? [], physicalBytes);
  const wantsSingle = physicalBytes <= SAVE_SINGLE_PUT_THRESHOLD_BYTES;
  if (wantsSingle !== (parts.length === 0)) {
    throw new ApiConfigurationError("The Save upload plan does not match the server upload boundary.");
  }
  const response = await client.post<unknown, unknown>(
    `${context.path}/save-sessions`,
    {
      physicalBytes,
      logicalBytes,
      fileCount,
      sha256: bundleChecksum,
      parts: parts.map(partRequest)
    },
    mutationOptions(options, {
      "if-match": projectEtag,
      "idempotency-key": idempotencyKey
    })
  );
  if (response.status !== 200 && response.status !== 201) throw invalidResponse(response);
  const data = parseSaveSession(
    response,
    context,
    physicalBytes,
    parts.length,
    bundleChecksum
  );
  if ((response.status === 200) !== data.idempotentRetry) throw invalidResponse(response);
  return {
    data,
    status: response.status,
    requestId: response.requestId,
    replayed: response.status === 200
  };
}

export async function issueSaveParts(
  client: ApiClient,
  input: IssueSavePartsInput,
  options: BrowserMutationOptions
): Promise<ApiResult<readonly SaveUploadCapability[]>> {
  const context = saveSessionContext(input);
  const parts = validatePartBatch(input.parts);
  const response = await client.post<unknown, unknown>(
    `${context.path}/save-sessions/${context.sessionId}/parts`,
    { parts: parts.map(partRequest) },
    mutationOptions(options)
  );
  return validatedResult(response, (value) => {
    if (!Array.isArray(value) || value.length !== parts.length || value.length > SAVE_MAX_PARTS) {
      throw invalidResponse(response);
    }
    return Object.freeze(value.map((item, index) => {
      const part = parts[index];
      if (part === undefined) throw invalidResponse(response);
      const capability = parseUploadCapability(item, {
        context,
        sessionId: context.sessionId,
        partNumber: part.partNumber,
        uploadKind: "part"
      });
      if (
        capability.expectedBytes !== part.expectedBytes ||
        uploadCapabilityChecksum(capability) !== hexToBase64(part.sha256)
      ) {
        throw invalidResponse(response);
      }
      return capability;
    }));
  });
}

export async function recordSaveReceipts(
  client: ApiClient,
  input: RecordSaveReceiptsInput,
  options: BrowserMutationOptions
): Promise<ApiEmptyResult> {
  const context = saveSessionContext(input);
  const receiptParts = validatePartBatch(input.receipts);
  const receipts = receiptParts.map((part, index) => ({
    ...partRequest(part),
    etag: validateReceiptEtag(input.receipts[index]?.etag)
  }));
  const response = await client.post<unknown, unknown>(
    `${context.path}/save-sessions/${context.sessionId}/parts/receipts`,
    { receipts },
    mutationOptions(options)
  );
  return requireNoContent(response);
}

export async function completeSaveSession(
  client: ApiClient,
  input: CompleteSaveSessionInput,
  options: BrowserMutationOptions
): Promise<SaveCommitResult> {
  const context = saveSessionContext(input);
  if (input.uploadMode !== "single" && input.uploadMode !== "multipart") {
    throw new ApiConfigurationError("The Save upload mode is invalid.");
  }
  const response = await client.post<unknown, unknown>(
    `${context.path}/save-sessions/${context.sessionId}/complete`,
    { uploadMode: input.uploadMode },
    mutationOptions(options)
  );
  const result = validatedResult(response, parseSaveCommit);
  const projectEtag = requireSingleHeader(response, "etag");
  if (validateProjectEtag(projectEtag) !== `"project-v${result.data.projectVersion}"`) {
    throw invalidResponse(response);
  }
  return { ...result, projectEtag };
}

export async function reconcileSaveSession(
  client: ApiClient,
  input: SaveSessionInput,
  options: BrowserMutationOptions
): Promise<ApiResult<SaveReconciliation>> {
  const context = saveSessionContext(input);
  const response = await client.post<unknown, unknown>(
    `${context.path}/save-sessions/${context.sessionId}/reconcile`,
    undefined,
    mutationOptions(options)
  );
  return validatedResult(response, parseReconciliation);
}

export async function abortSaveSession(
  client: ApiClient,
  input: SaveSessionInput,
  options: BrowserMutationOptions
): Promise<ApiEmptyResult> {
  const context = saveSessionContext(input);
  const response = await client.delete<unknown>(
    `${context.path}/save-sessions/${context.sessionId}`,
    mutationOptions(options)
  );
  return requireNoContent(response);
}

export async function getProjectContentDescriptor(
  client: ApiClient,
  input: SaveProjectInput,
  options: DomainRequestOptions = {}
): Promise<ProjectContentDescriptorResult> {
  const context = saveContext(input);
  const response = await client.get<unknown>(`${context.path}/content`, options);
  const result = validatedResult(response, (value) => parseContentDescriptor(value, context));
  const etag = requireSingleHeader(response, "etag");
  if (etag !== result.data.etag) throw invalidResponse(response);
  return { ...result, etag };
}

export async function uploadSaveCapability<Capability extends SaveUploadCapability>(
  capabilityInput: Capability,
  partInput: SavePart,
  body: Blob,
  ...optionInput: [Capability] extends [DirectSaveUploadCapability]
    ? [options?: UploadSaveCapabilityOptions<Capability>]
    : [options: UploadSaveCapabilityOptions<Capability>]
): Promise<SaveUploadResult<Capability>> {
  const options = (optionInput[0] ?? {}) as UploadSaveCapabilityOptions;
  const part = validateUploadPart(partInput);
  const expectedRelay = readRelayUploadExpectation(capabilityInput, part, options);
  const capability = validateUploadCapabilityInput(capabilityInput, expectedRelay);
  if (
    part.expectedBytes !== capability.expectedBytes ||
    hexToBase64(part.sha256) !== uploadCapabilityChecksum(capability)
  ) {
    throw new ApiConfigurationError("The upload part does not match the upload capability.");
  }
  if (!(body instanceof Blob) || body.size !== capability.expectedBytes) {
    throw new ApiConfigurationError("The upload body does not match the upload capability.");
  }
  return withTransferDeadline("upload", options, async (signal, fetchImplementation) => {
    const headers = new Headers();
    for (const header of capability.headers) {
      if (!BROWSER_MANAGED_UPLOAD_HEADERS.has(header.name)) headers.set(header.name, header.value);
    }
    if (capability.transport === "relay") {
      headers.set("x-csrf-token", expectedRelay?.csrfToken ?? "");
    }
    let response: Response;
    try {
      response = await fetchImplementation(
        capability.transport === "direct" ? capability.url : capability.path,
        {
          method: "PUT",
          body,
          headers,
          credentials: capability.transport === "direct" ? "omit" : "same-origin",
          redirect: "error",
          referrerPolicy: "no-referrer",
          signal
        }
      );
    } catch {
      if (signal.aborted) throw transferAbortError("upload", signal);
      throw new ProjectTransferError("upload", "transport", { retryable: true });
    }
    if (signal.aborted) {
      await cancelBody(response.body);
      throw transferAbortError("upload", signal);
    }
    const expectedStatus = capability.transport === "direct" ? 200 : 204;
    if (response.status !== expectedStatus) {
      if (capability.transport === "relay" && !response.ok) {
        throw await apiErrorFromRawResponse(response);
      }
      await cancelBody(response.body);
      throw new ProjectTransferError("upload", response.ok ? "invalid-response" : "rejected", {
        status: response.status,
        retryable: isRetryableStatus(response.status)
      });
    }
    await cancelBody(response.body);
    if (capability.transport === "relay") {
      return { transport: "relay" } as SaveUploadResult<Capability>;
    }
    let etag: string;
    try {
      etag = validateReceiptEtag(response.headers.get("etag"));
    } catch {
      throw new ProjectTransferError("upload", "invalid-response");
    }
    const expectedChecksum = uploadCapabilityChecksum(capability);
    const returnedChecksum = response.headers.get("x-amz-checksum-sha256");
    if (returnedChecksum !== null && expectedChecksum !== returnedChecksum) {
      throw new ProjectTransferError("upload", "integrity");
    }
    return {
      transport: "direct",
      receipt: { ...part, etag }
    } as SaveUploadResult<Capability>;
  });
}

export async function downloadProjectContent<Result>(
  descriptorInput: ProjectContentDescriptor,
  options: DownloadProjectContentOptions<Result>
): Promise<ProjectContentDownloadResult<Result>> {
  const descriptor = validateContentDescriptorInput(descriptorInput);
  const maxBytes = normalizeTransferLimit(options.maxBytes ?? DEFAULT_PROJECT_CONTENT_MAX_BYTES);
  if (descriptor.physicalBytes > maxBytes) {
    throw new ProjectTransferError("download", "too-large");
  }
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const sink = options.sink;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let sinkStarted = false;
  try {
    return await withTransferDeadline("download", options, async (signal, fetchImplementation) => {
      let response: Response;
      try {
        response = await fetchImplementation(`${baseUrl}${descriptor.downloadUrl}`, {
          method: "GET",
          credentials: options.credentials ?? "include",
          headers: { accept: "application/octet-stream", "if-match": descriptor.etag },
          redirect: "error",
          signal
        });
      } catch {
        if (signal.aborted) throw transferAbortError("download", signal);
        throw new ProjectTransferError("download", "transport", { retryable: true });
      }
      if (signal.aborted) {
        await cancelBody(response.body);
        throw transferAbortError("download", signal);
      }
      if (!response.ok) throw await apiErrorFromRawResponse(response);
      try {
        validateDownloadResponse(response, descriptor, maxBytes);
      } catch (error) {
        await cancelBody(response.body);
        throw error;
      }
      if (response.body === null) throw new ProjectTransferError("download", "invalid-response");
      reader = response.body.getReader();
      sinkStarted = true;
      const digest = new IncrementalSha256();
      let receivedBytes = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          receivedBytes += value.byteLength;
          if (receivedBytes > descriptor.physicalBytes || receivedBytes > maxBytes) {
            throw new ProjectTransferError("download", "too-large");
          }
          digest.update(value);
          try {
            await sink.write(value, signal);
          } catch {
            throw new ProjectTransferError("download", "sink");
          } finally {
            value.fill(0);
          }
        }
        if (receivedBytes !== descriptor.physicalBytes) {
          throw new ProjectTransferError("download", "invalid-response");
        }
        if (bytesToBase64Url(digest.finish()) !== descriptor.checksum) {
          throw new ProjectTransferError("download", "integrity");
        }
        let sinkResult: Result;
        try {
          sinkResult = await sink.complete(descriptor, signal);
        } catch {
          throw new ProjectTransferError("download", "sink");
        }
        return { descriptor, sinkResult, receivedBytes };
      } catch (error) {
        try {
          await reader.cancel();
        } catch {
          // The stable download failure remains authoritative.
        }
        throw error;
      } finally {
        digest.dispose();
        reader?.releaseLock();
        reader = undefined;
      }
    });
  } catch (error) {
    const transferError = normalizeTransferFailure(error);
    const deadlineFailure = transferError.kind === "aborted" || transferError.kind === "timeout";
    if (reader !== undefined) {
      const cancellation = cancelReader(reader);
      if (deadlineFailure) void cancellation;
      else await cancellation;
    }
    if (sinkStarted) {
      const abortion = abortSink(sink, transferError);
      if (deadlineFailure) void abortion;
      else await abortion;
    }
    throw error instanceof ApiError ? error : transferError;
  }
}

function validateUploadPart(part: SavePart): SavePart {
  if (
    typeof part !== "object" || part === null || !Number.isInteger(part.partNumber) ||
    part.partNumber < 1 || part.partNumber > SAVE_MAX_PARTS
  ) {
    throw new ApiConfigurationError("The Save upload part is invalid.");
  }
  return {
    partNumber: part.partNumber,
    expectedBytes: readTransferSize(part.expectedBytes, "part byte count", false),
    sha256: validateSha256Hex(part.sha256)
  };
}

function validatePartBatch(parts: readonly SavePart[]): readonly SavePart[] {
  if (!Array.isArray(parts) || parts.length === 0 || parts.length > SAVE_PART_BATCH_LIMIT) {
    throw new ApiConfigurationError("The Save part batch is invalid.");
  }
  const validated = parts.map(validateUploadPart);
  for (let index = 1; index < validated.length; index += 1) {
    if (validated[index]?.partNumber !== (validated[index - 1]?.partNumber ?? 0) + 1) {
      throw new ApiConfigurationError("The Save part batch must be consecutive.");
    }
  }
  return Object.freeze(validated);
}

function saveContext(input: SaveProjectInput): {
  readonly owner: ProjectOwner;
  readonly projectId: string;
  readonly path: `/${string}`;
} {
  const owner = validateOwner(input.owner);
  const projectId = validateUuid(input.projectId, "Project ID");
  const ownerSegment = owner.ownerType === "user" ? "users" : "organizations";
  return {
    owner,
    projectId,
    path: `/workspaces/${ownerSegment}/${owner.ownerId}/projects/${projectId}`
  };
}

function saveSessionContext(input: SaveSessionInput): ReturnType<typeof saveContext> & {
  readonly sessionId: string;
} {
  return { ...saveContext(input), sessionId: validateUuid(input.sessionId, "Save session ID") };
}

function validateOwner(owner: ProjectOwner): ProjectOwner {
  if (
    typeof owner !== "object" || owner === null ||
    (owner.ownerType !== "user" && owner.ownerType !== "organization")
  ) {
    throw new ApiConfigurationError("The Project owner is invalid.");
  }
  return { ownerType: owner.ownerType, ownerId: validateUuid(owner.ownerId, "owner ID") };
}

function validateUuid(value: string, label: string): string {
  if (typeof value !== "string" || !UUID_V7.test(value)) {
    throw new ApiConfigurationError(`The ${label} is invalid.`);
  }
  return value;
}

function validateProjectEtag(value: string): string {
  const match = typeof value === "string" ? value.match(PROJECT_ETAG) : null;
  const version = match?.[1];
  if (version === undefined || !Number.isSafeInteger(Number(version)) || Number(version) > MAX_PROJECT_VERSION) {
    throw new ApiConfigurationError("The Project ETag is invalid.");
  }
  return value;
}

function validateIdempotencyKey(value: string): string {
  if (typeof value !== "string" || !IDEMPOTENCY_KEY.test(value)) {
    throw new ApiConfigurationError("The Save idempotency key is invalid.");
  }
  return value;
}

function validateSha256Hex(value: string): string {
  if (typeof value !== "string" || !SHA256_HEX.test(value)) {
    throw new ApiConfigurationError("The SHA-256 digest is invalid.");
  }
  return value;
}

function readTransferSize(value: number, label: string, allowZero: boolean): number {
  if (
    !Number.isSafeInteger(value) || value < (allowZero ? 0 : 1) || value > MAX_TRANSFER_BYTES
  ) {
    throw new ApiConfigurationError(`The ${label} is invalid.`);
  }
  return value;
}

function readCount(value: number, maximum: number, label: string, allowZero = false): number {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1) || value > maximum) {
    throw new ApiConfigurationError(`The ${label} is invalid.`);
  }
  return value;
}

function validateParts(parts: readonly SavePart[], totalBytes?: number): readonly SavePart[] {
  if (!Array.isArray(parts) || parts.length > SAVE_MAX_PARTS) {
    throw new ApiConfigurationError("The Save part plan is invalid.");
  }
  let expectedTotal = 0;
  const result = Object.freeze(parts.map((part, index) => {
    if (typeof part !== "object" || part === null || part.partNumber !== index + 1) {
      throw new ApiConfigurationError("The Save part plan is invalid.");
    }
    const expectedBytes = readTransferSize(part.expectedBytes, "part byte count", false);
    expectedTotal += expectedBytes;
    if (!Number.isSafeInteger(expectedTotal)) {
      throw new ApiConfigurationError("The Save part plan is invalid.");
    }
    const validated = {
      partNumber: part.partNumber,
      expectedBytes,
      sha256: validateSha256Hex(part.sha256)
    };
    if (index < parts.length - 1 && expectedBytes !== SAVE_MULTIPART_PART_BYTES) {
      throw new ApiConfigurationError("Every non-final Save part must use the canonical size.");
    }
    if (expectedBytes > SAVE_MULTIPART_PART_BYTES) {
      throw new ApiConfigurationError("A Save part exceeds the canonical size.");
    }
    return validated;
  }));
  if (totalBytes !== undefined && parts.length > 0 && expectedTotal !== totalBytes) {
    throw new ApiConfigurationError("The Save part plan byte count does not match the Bundle.");
  }
  return result;
}

function partRequest(part: SavePart): { partNumber: number; expectedBytes: number; sha256: string } {
  return {
    partNumber: part.partNumber,
    expectedBytes: part.expectedBytes,
    sha256: hexToBase64(part.sha256)
  };
}

function parseSaveSession(
  response: ApiResponse<unknown>,
  context: ReturnType<typeof saveContext>,
  physicalBytes: number,
  plannedParts: number,
  requestedChecksum: string
): SaveSession {
  try {
    const record = readExactRecord(response.data, [
      "expiresAt", "idempotentRetry", "partCount", "sessionId", "upload", "uploadMode"
    ]);
    const uploadMode = readBoundedString(record, "uploadMode", 16);
    if (uploadMode !== "single" && uploadMode !== "multipart") throw new TypeError("invalid mode");
    const sessionId = readUuidV7(record, "sessionId");
    const partCount = readPositiveInteger(record, "partCount", SAVE_MAX_PARTS);
    const upload = record.upload === null
      ? null
      : parseUploadCapability(record.upload, {
        context,
        sessionId,
        partNumber: 1,
        uploadKind: "single"
      });
    if (
      (uploadMode === "single" && (
        partCount !== 1 || upload === null || upload.expectedBytes !== physicalBytes ||
        uploadCapabilityChecksum(upload) !== requestedChecksum
      )) ||
      (uploadMode === "multipart" && (partCount !== plannedParts || upload !== null))
    ) {
      throw new TypeError("invalid upload contract");
    }
    return {
      sessionId,
      uploadMode,
      expiresAt: readUtcTimestamp(record, "expiresAt"),
      partCount,
      idempotentRetry: readBoolean(record, "idempotentRetry"),
      upload
    };
  } catch (error) {
    if (error instanceof ApiInvalidResponseError) throw error;
    throw invalidResponse(response);
  }
}

interface UploadCapabilityExpectation {
  readonly context: ReturnType<typeof saveContext>;
  readonly sessionId: string;
  readonly partNumber: number;
  readonly uploadKind: "single" | "part";
}

interface RelayUploadExpectation extends UploadCapabilityExpectation {
  readonly csrfToken: string;
}

function parseUploadCapability(
  value: unknown,
  expectation?: UploadCapabilityExpectation
): SaveUploadCapability {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("invalid upload capability");
  }
  const transport = (value as Record<string, unknown>).transport;
  if (transport === "direct") return parseDirectUploadCapability(value);
  if (transport === "relay") return parseRelayUploadCapability(value, expectation);
  throw new TypeError("invalid upload transport");
}

function parseDirectUploadCapability(value: unknown): DirectSaveUploadCapability {
  const record = readExactRecord(value, [
    "expectedBytes", "headers", "method", "transport", "url"
  ]);
  if (readBoundedString(record, "transport", 16) !== "direct") {
    throw new TypeError("invalid upload transport");
  }
  if (readBoundedString(record, "method", 8) !== "PUT") throw new TypeError("invalid method");
  const expectedBytes = readNonNegativeInteger(record, "expectedBytes", MAX_TRANSFER_BYTES);
  if (expectedBytes === 0) throw new TypeError("empty upload");
  const url = readBoundedString(record, "url", MAX_CAPABILITY_URL_BYTES);
  const parsedUrl = validateCapabilityUrl(url);
  const headers = parseUploadHeaders(record, DIRECT_UPLOAD_HEADERS);
  validateDirectUploadHeaders(headers, expectedBytes, parsedUrl);
  return Object.freeze({
    transport: "direct",
    method: "PUT",
    url,
    headers,
    expectedBytes
  });
}

function parseRelayUploadCapability(
  value: unknown,
  expectation?: UploadCapabilityExpectation
): RelaySaveUploadCapability {
  const record = readExactRecord(value, [
    "expectedBytes", "headers", "method", "path", "transport"
  ]);
  if (readBoundedString(record, "transport", 16) !== "relay") {
    throw new TypeError("invalid upload transport");
  }
  if (readBoundedString(record, "method", 8) !== "PUT") throw new TypeError("invalid method");
  const expectedBytes = readNonNegativeInteger(record, "expectedBytes", MAX_TRANSFER_BYTES);
  if (expectedBytes === 0) throw new TypeError("empty upload");
  const path = readBoundedString(record, "path", MAX_CAPABILITY_PATH_BYTES);
  validateRelayPath(path, expectation);
  const headers = parseUploadHeaders(record, RELAY_UPLOAD_HEADERS);
  validateRelayUploadHeaders(headers);
  return Object.freeze({
    transport: "relay",
    method: "PUT",
    path: path as `/${string}`,
    headers,
    expectedBytes
  });
}

function parseUploadHeaders(
  record: Record<string, unknown>,
  allowed: ReadonlySet<string>
): readonly SaveUploadHeader[] {
  const headerInputs = readBoundedArray(record, "headers", MAX_UPLOAD_HEADERS);
  const names = new Set<string>();
  const headers = headerInputs.map((headerInput) => {
    const header = readExactRecord(headerInput, ["name", "value"]);
    const inputName = readBoundedString(header, "name", 128);
    const name = inputName.toLowerCase();
    const value = readBoundedString(header, "value", MAX_HEADER_BYTES);
    if (
      !HEADER_NAME.test(inputName) ||
      !allowed.has(name) || names.has(name)
    ) {
      throw new TypeError("invalid signed header");
    }
    names.add(name);
    return Object.freeze({ name, value });
  });
  return Object.freeze(headers);
}

function validateDirectUploadHeaders(
  headers: readonly SaveUploadHeader[],
  expectedBytes: number,
  url: URL
): void {
  const declaredLength = headers.find((header) => header.name === "content-length")?.value;
  if (declaredLength !== undefined && declaredLength !== String(expectedBytes)) {
    throw new TypeError("invalid signed content length");
  }
  const checksum = headers.find((header) => header.name === "x-amz-checksum-sha256")?.value;
  if (checksum === undefined || decodeBase64Checksum(checksum) === undefined) {
    throw new TypeError("missing checksum");
  }
  const contentType = headers.find((header) => header.name === "content-type")?.value;
  if (contentType !== undefined && contentType !== BUNDLE_CONTENT_TYPE) {
    throw new TypeError("invalid signed content type");
  }
  const algorithm = headers.find(
    (header) => header.name === "x-amz-sdk-checksum-algorithm"
  )?.value;
  if (algorithm !== undefined && algorithm !== "SHA256") {
    throw new TypeError("invalid checksum algorithm");
  }
  const host = headers.find((header) => header.name === "host")?.value;
  if (host !== undefined && host !== url.host) throw new TypeError("invalid signed host");
}

function validateRelayUploadHeaders(headers: readonly SaveUploadHeader[]): void {
  if (headers.length !== RELAY_UPLOAD_HEADERS.size) {
    throw new TypeError("invalid relay headers");
  }
  const contentType = headers.find((header) => header.name === "content-type")?.value;
  const checksum = headers.find(
    (header) => header.name === "x-nuriteo-content-sha256"
  )?.value;
  if (
    contentType !== BUNDLE_CONTENT_TYPE || checksum === undefined ||
    decodeBase64Checksum(checksum) === undefined
  ) {
    throw new TypeError("invalid relay headers");
  }
}

function validateUploadCapabilityInput(
  value: unknown,
  expectation?: UploadCapabilityExpectation
): SaveUploadCapability {
  try {
    return parseUploadCapability(value, expectation);
  } catch {
    throw new ApiConfigurationError("The upload capability is invalid.");
  }
}

function validateCapabilityUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError("invalid capability URL");
  }
  if (
    url.protocol !== "https:" || url.username !== "" || url.password !== "" ||
    url.hash !== ""
  ) {
    throw new TypeError("invalid capability URL");
  }
  return url;
}

function validateRelayPath(
  value: string,
  expectation?: UploadCapabilityExpectation
): void {
  if (
    !value.startsWith("/api/v1/workspaces/") || value.startsWith("//") ||
    value.includes("?") || value.includes("#") || value.includes("%")
  ) {
    throw new TypeError("invalid relay path");
  }
  if (expectation !== undefined && value !== relayUploadPath(expectation)) {
    throw new TypeError("mismatched relay path");
  }
}

function relayUploadPath(expectation: UploadCapabilityExpectation): string {
  const base = `/api/v1${expectation.context.path}/save-sessions/${expectation.sessionId}/upload`;
  return expectation.uploadKind === "single"
    ? base
    : `${base}/parts/${expectation.partNumber}`;
}

function readRelayUploadExpectation(
  capability: unknown,
  part: SavePart,
  options: UploadSaveCapabilityOptions
): RelayUploadExpectation | undefined {
  validateTransferOptionKeys(capability, options);
  const transport = typeof capability === "object" && capability !== null
    ? (capability as Record<string, unknown>).transport
    : undefined;
  if (transport !== "relay") return undefined;
  const relayOptions = options as TransferRequestOptions & Partial<RelayUploadIdentity>;
  try {
    validateHeaderValue(relayOptions.csrfToken as string, "CSRF credential");
    if (relayOptions.uploadMode !== "single" && relayOptions.uploadMode !== "multipart") {
      throw new TypeError("invalid upload mode");
    }
    const context = saveSessionContext({
      owner: relayOptions.owner as ProjectOwner,
      projectId: relayOptions.projectId as string,
      sessionId: relayOptions.sessionId as string
    });
    if (relayOptions.uploadMode === "single" && part.partNumber !== 1) {
      throw new TypeError("invalid single upload part");
    }
    return {
      context,
      sessionId: context.sessionId,
      partNumber: part.partNumber,
      uploadKind: relayOptions.uploadMode === "single" ? "single" : "part",
      csrfToken: relayOptions.csrfToken as string
    };
  } catch {
    throw new ApiConfigurationError("The relay upload identity is invalid.");
  }
}

function validateTransferOptionKeys(
  capability: unknown,
  options: UploadSaveCapabilityOptions
): void {
  if (typeof options !== "object" || options === null || Array.isArray(options)) {
    throw new ApiConfigurationError("The upload request options are invalid.");
  }
  const transport = typeof capability === "object" && capability !== null
    ? (capability as Record<string, unknown>).transport
    : undefined;
  const allowed = new Set(
    transport === "relay"
      ? ["csrfToken", "fetch", "owner", "projectId", "sessionId", "signal", "timeoutMs", "uploadMode"]
      : ["fetch", "signal", "timeoutMs"]
  );
  if (Object.keys(options).some((key) => !allowed.has(key))) {
    throw new ApiConfigurationError("The upload request options are invalid.");
  }
  if (options.fetch !== undefined && typeof options.fetch !== "function") {
    throw new ApiConfigurationError("The upload request transport is invalid.");
  }
}

function parseSaveCommit(value: unknown): SaveCommit {
  const record = readExactRecord(value, ["bundleId", "projectVersion"]);
  return {
    bundleId: readUuidV7(record, "bundleId"),
    projectVersion: readPositiveInteger(record, "projectVersion", MAX_PROJECT_VERSION)
  };
}

function parseReconciliation(value: unknown): SaveReconciliation {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("invalid reconciliation");
  }
  const state = (value as Record<string, unknown>).state;
  if (state === "notCommitted") {
    readExactRecord(value, ["state"]);
    return { state };
  }
  const record = readExactRecord(value, ["bundleId", "projectVersion", "state"]);
  if (readBoundedString(record, "state", 32) !== "committed") {
    throw new TypeError("invalid reconciliation state");
  }
  return {
    state: "committed",
    bundleId: readUuidV7(record, "bundleId"),
    projectVersion: readPositiveInteger(record, "projectVersion", MAX_PROJECT_VERSION)
  };
}

function parseContentDescriptor(
  value: unknown,
  expected?: ReturnType<typeof saveContext>
): ProjectContentDescriptor {
  const record = readExactRecord(value, [
    "bundleId", "checksum", "checksumAlgorithm", "downloadUrl", "etag", "fileCount",
    "format", "logicalBytes", "physicalBytes", "projectId", "projectVersion"
  ]);
  const projectId = readUuidV7(record, "projectId");
  const bundleId = readUuidV7(record, "bundleId");
  const projectVersion = readPositiveInteger(record, "projectVersion", MAX_PROJECT_VERSION);
  const etag = readBoundedString(record, "etag", 256);
  const etagMatch = etag.match(CONTENT_ETAG);
  const checksum = readBoundedString(record, "checksum", 64);
  if (
    etagMatch === null || Number(etagMatch[1]) !== projectVersion || etagMatch[2] !== checksum ||
    !SHA256_BASE64URL.test(checksum)
  ) {
    throw new TypeError("invalid content identity");
  }
  if (
    readBoundedString(record, "checksumAlgorithm", 16) !== "sha-256" ||
    readBoundedString(record, "format", 64) !== "project-bundle-v1"
  ) {
    throw new TypeError("invalid content format");
  }
  const physicalBytes = readNonNegativeInteger(record, "physicalBytes", MAX_TRANSFER_BYTES);
  if (physicalBytes === 0) throw new TypeError("empty bundle");
  const logicalBytes = readNonNegativeInteger(record, "logicalBytes", MAX_TRANSFER_BYTES);
  const fileCount = readNonNegativeInteger(record, "fileCount", 100_000);
  const downloadUrl = readBoundedString(record, "downloadUrl", 2_048);
  const expectedPath = expected === undefined
    ? undefined
    : `/api/v1${expected.path}/content/${bundleId}`;
  if (
    !downloadUrl.startsWith("/api/v1/") || downloadUrl.startsWith("//") ||
    downloadUrl.includes("?") || downloadUrl.includes("#") ||
    (expectedPath !== undefined && downloadUrl !== expectedPath) ||
    (expected !== undefined && projectId !== expected.projectId)
  ) {
    throw new TypeError("invalid download path");
  }
  return {
    projectId,
    projectVersion,
    bundleId,
    etag,
    checksumAlgorithm: "sha-256",
    checksum,
    physicalBytes,
    logicalBytes,
    fileCount,
    format: "project-bundle-v1",
    downloadUrl
  };
}

function validateContentDescriptorInput(value: unknown): ProjectContentDescriptor {
  try {
    return parseContentDescriptor(value);
  } catch {
    throw new ApiConfigurationError("The Project content descriptor is invalid.");
  }
}

function readNonNegativeInteger(
  record: Record<string, unknown>,
  key: string,
  maximum: number
): number {
  const value = record[key];
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) {
    throw new TypeError("invalid integer");
  }
  return value as number;
}

function validateReceiptEtag(value: string | null | undefined): string {
  if (
    typeof value !== "string" || encoder.encode(value).byteLength > 512 ||
    !/^"[\x21\x23-\x7e\x80-\xff]+"$/u.test(value)
  ) {
    throw new ApiConfigurationError("The upload receipt ETag is invalid.");
  }
  return value;
}

function requireSingleHeader(response: ApiResponse<unknown>, name: string): string {
  const value = response.headers.get(name);
  if (value === null || value.includes(",")) throw invalidResponse(response);
  return value;
}

function normalizeTransferLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_TRANSFER_BYTES) {
    throw new ApiConfigurationError("The Project content byte limit is invalid.");
  }
  return value;
}

function normalizeTransferTimeout(value: number | undefined): number {
  const timeout = value ?? DEFAULT_PROJECT_TRANSFER_TIMEOUT_MS;
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > MAX_PROJECT_TRANSFER_TIMEOUT_MS) {
    throw new ApiConfigurationError("The Project transfer timeout is invalid.");
  }
  return timeout;
}

function normalizeBaseUrl(value: string | undefined): string {
  if (value === undefined || value === "") return "";
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ApiConfigurationError("The Project content base URL is invalid.");
  }
  if (
    !["http:", "https:"].includes(url.protocol) || url.username !== "" || url.password !== "" ||
    url.pathname !== "/" || url.search !== "" || url.hash !== "" ||
    (typeof globalThis.location !== "undefined" && url.origin !== globalThis.location.origin)
  ) {
    throw new ApiConfigurationError("The Project content base URL is invalid.");
  }
  return url.origin;
}

async function withTransferDeadline<Result>(
  phase: ProjectTransferPhase,
  options: TransferRequestOptions,
  operation: (signal: AbortSignal, fetchImplementation: typeof globalThis.fetch) => Promise<Result>
): Promise<Result> {
  const timeoutMs = normalizeTransferTimeout(options.timeoutMs);
  const externalSignal = options.signal;
  if (externalSignal?.aborted) throw new ProjectTransferError(phase, "aborted");
  const controller = new AbortController();
  let source: "external" | "timeout" | undefined;
  let rejectDeadline: (reason: ProjectTransferError) => void = () => undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    rejectDeadline = reject;
  });
  const stop = (nextSource: "external" | "timeout") => {
    if (source === undefined) {
      source = nextSource;
      controller.abort();
      rejectDeadline(transferAbortError(phase, controller.signal, nextSource));
    }
  };
  const onAbort = () => stop("external");
  externalSignal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => stop("timeout"), timeoutMs);
  const operationPromise = Promise.resolve().then(
    () => operation(controller.signal, options.fetch ?? globalThis.fetch)
  );
  // The deadline may win while an injected fetch or sink ignores AbortSignal.
  // Keep a rejection observer attached until that untrusted operation eventually settles.
  void operationPromise.catch(() => undefined);
  try {
    return await Promise.race([operationPromise, deadline]);
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener("abort", onAbort);
  }
}

function uploadCapabilityChecksum(capability: SaveUploadCapability): string | undefined {
  return capability.headers.find(
    (header) => header.name === (
      capability.transport === "direct"
        ? "x-amz-checksum-sha256"
        : "x-nuriteo-content-sha256"
    )
  )?.value;
}

function transferAbortError(
  phase: ProjectTransferPhase,
  _signal: AbortSignal,
  source?: "external" | "timeout"
): ProjectTransferError {
  return source === "timeout"
    ? new ProjectTransferError(phase, "timeout", { retryable: true })
    : new ProjectTransferError(phase, "aborted");
}

function normalizeTransferFailure(error: unknown): ProjectTransferError {
  if (error instanceof ProjectTransferError) return error;
  if (error instanceof ApiTimeoutError) return new ProjectTransferError("download", "timeout", { retryable: true });
  if (error instanceof ApiAbortError) return new ProjectTransferError("download", "aborted");
  return new ProjectTransferError("download", "transport", { retryable: true });
}

function validateDownloadResponse(
  response: Response,
  descriptor: ProjectContentDescriptor,
  maxBytes: number
): void {
  const contentLength = response.headers.get("content-length");
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  const contentEncoding = response.headers.get("content-encoding")?.trim().toLowerCase();
  if (
    contentLength === null || !/^\d+$/u.test(contentLength) ||
    BigInt(contentLength) !== BigInt(descriptor.physicalBytes) ||
    BigInt(contentLength) > BigInt(maxBytes) ||
    response.headers.get("etag") !== descriptor.etag ||
    contentType !== "application/octet-stream" ||
    (contentEncoding !== undefined && contentEncoding !== "identity")
  ) {
    throw new ProjectTransferError("download", "invalid-response");
  }
}

async function apiErrorFromRawResponse(response: Response): Promise<ApiError> {
  const requestId = response.headers.get("x-request-id")?.trim() || undefined;
  const problem = await readProblemDetails(response);
  return new ApiError(response.status, requestId ?? problem?.request_id, problem);
}

async function readProblemDetails(response: Response): Promise<ProblemDetails | undefined> {
  if (response.body === null) return undefined;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_PROBLEM_BYTES) {
        await reader.cancel();
        return undefined;
      }
      chunks.push(value);
    }
  } catch {
    return undefined;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return undefined;
  } finally {
    bytes.fill(0);
    for (const chunk of chunks) chunk.fill(0);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const text = (key: string) => typeof record[key] === "string" ? record[key] as string : undefined;
  const type = text("type");
  const title = text("title");
  const detail = text("detail");
  const instance = text("instance");
  const code = text("code");
  const problemRequestId = text("request_id");
  if (
    type === undefined || title === undefined || detail === undefined || instance === undefined ||
    code === undefined || problemRequestId === undefined || !/^[A-Z][A-Z0-9_]{0,127}$/u.test(code)
  ) return undefined;
  return {
    type,
    title,
    status: response.status,
    detail,
    instance,
    code,
    request_id: problemRequestId,
    errors: parseFieldViolations(record.errors)
  };
}

function parseFieldViolations(value: unknown): readonly FieldViolation[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 32).flatMap((item) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    return typeof record.path === "string" && typeof record.code === "string" &&
      typeof record.detail === "string"
      ? [{ path: record.path, code: record.code, detail: record.detail }]
      : [];
  });
}

async function cancelBody(body: ReadableStream<Uint8Array> | null): Promise<void> {
  if (body === null) return;
  try {
    await body.cancel();
  } catch {
    // Response cleanup must not replace the stable transfer result.
  }
}

async function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
  try {
    await reader.cancel();
  } catch {
    // The stable transfer failure remains authoritative.
  }
}

async function abortSink<Result>(
  sink: ProjectContentSink<Result>,
  reason: ProjectTransferError
): Promise<void> {
  try {
    await sink.abort(reason);
  } catch {
    // The stable transfer failure remains authoritative.
  }
}

function hexToBase64(hex: string): string {
  const bytes = new Uint8Array(32);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytesToBase64(bytes);
}

function bytesToBase64(bytes: Uint8Array): string {
  let value = "";
  for (const byte of bytes) value += String.fromCharCode(byte);
  return btoa(value);
}

function bytesToBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function decodeBase64Checksum(value: string): Uint8Array | undefined {
  if (!/^[A-Za-z0-9+/]{43}=$/u.test(value)) return undefined;
  try {
    const decoded = atob(value);
    if (decoded.length !== 32) return undefined;
    return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
  } catch {
    return undefined;
  }
}

function isRetryableStatus(status: number): boolean {
  return [408, 425, 429, 500, 502, 503, 504].includes(status);
}

function projectTransferMessage(
  phase: ProjectTransferPhase,
  kind: ProjectTransferErrorKind
): string {
  const operation = phase === "upload" ? "upload" : "download";
  switch (kind) {
    case "aborted": return `The Project ${operation} was cancelled.`;
    case "timeout": return `The Project ${operation} timed out.`;
    case "rejected": return "The object storage service rejected the Project upload.";
    case "invalid-response": return `The Project ${operation} response was invalid.`;
    case "too-large": return "The Project download exceeded the configured byte limit.";
    case "integrity": return `The Project ${operation} failed its integrity check.`;
    case "sink": return "The Project download destination failed.";
    case "transport": return `The Project ${operation} could not be completed.`;
  }
}
