import { mutationOptions } from "../browser-mutation.ts";

import type { BrowserMutationOptions } from "../browser-mutation.ts";
import { type ApiEmptyResult, type ApiResult, type DomainRequestOptions, invalidResponse, requireNoContent, validatedResult } from "../domain.ts";
import { ApiConfigurationError, ApiError } from "../errors.ts";
import { IncrementalSha256 } from "../incremental-sha256.ts";
import type { ProjectOwner } from "./projects.ts";
import type { ApiClient } from "../types.ts";


import { abortSink, apiErrorFromRawResponse, bytesToBase64Url, cancelBody, cancelReader, hexToBase64, isRetryableStatus, normalizeBaseUrl, normalizeTransferFailure, normalizeTransferLimit, parseContentDescriptor, parseReconciliation, parseSaveCommit, parseSaveSession, parseUploadCapability, partRequest, projectTransferMessage, readCount, readRelayUploadExpectation, readTransferSize, requireSingleHeader, saveContext, saveSessionContext, transferAbortError, uploadCapabilityChecksum, validateContentDescriptorInput, validateDownloadResponse, validateIdempotencyKey, validatePartBatch, validateParts, validateProjectEtag, validateReceiptEtag, validateSha256Hex, validateUploadCapabilityInput, validateUploadPart, withTransferDeadline } from "./saves-validate.ts";

export type { UploadCapabilityExpectation, RelayUploadExpectation } from "./saves-validate.ts";
export { validateUploadPart, validatePartBatch, saveContext, saveSessionContext, validateOwner, validateUuid, validateProjectEtag, validateIdempotencyKey, validateSha256Hex, readTransferSize, readCount, validateParts, partRequest, parseSaveSession, parseUploadCapability, parseDirectUploadCapability, parseRelayUploadCapability, parseUploadHeaders, validateDirectUploadHeaders, validateRelayUploadHeaders, validateUploadCapabilityInput, validateCapabilityUrl, validateRelayPath, relayUploadPath, readRelayUploadExpectation, validateTransferOptionKeys, parseSaveCommit, parseReconciliation, parseContentDescriptor, validateContentDescriptorInput, readNonNegativeInteger, validateReceiptEtag, requireSingleHeader, normalizeTransferLimit, normalizeTransferTimeout, normalizeBaseUrl, withTransferDeadline, uploadCapabilityChecksum, transferAbortError, normalizeTransferFailure, validateDownloadResponse, apiErrorFromRawResponse, readProblemDetails, parseFieldViolations, cancelBody, cancelReader, abortSink, hexToBase64, bytesToBase64, bytesToBase64Url, decodeBase64Checksum, isRetryableStatus, projectTransferMessage } from "./saves-validate.ts";

export const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
export const PROJECT_ETAG = /^"project-v([1-9]\d*)"$/u;
export const CONTENT_ETAG = /^"content-v([1-9]\d*)-([A-Za-z0-9_-]{43})"$/u;
export const SHA256_HEX = /^[0-9a-f]{64}$/u;
export const SHA256_BASE64URL = /^[A-Za-z0-9_-]{43}$/u;
export const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u;
export const IDEMPOTENCY_KEY = /^[A-Za-z0-9._-]{16,128}$/u;
export const MAX_PROJECT_VERSION = 9_007_199_254_740_991;
export const MAX_TRANSFER_BYTES = 2 * 1024 * 1024 * 1024;
export const MAX_UPLOAD_HEADERS = 16;
export const MAX_HEADER_BYTES = 8_192;
export const MAX_CAPABILITY_URL_BYTES = 16_384;
export const MAX_CAPABILITY_PATH_BYTES = 2_048;
export const MAX_PROBLEM_BYTES = 64 * 1024;
export const encoder = new TextEncoder();

export const SAVE_SINGLE_PUT_THRESHOLD_BYTES = 64 * 1024 * 1024;
export const SAVE_MULTIPART_PART_BYTES = 16 * 1024 * 1024;
export const SAVE_MAX_PARTS = 128;
export const SAVE_PART_BATCH_LIMIT = 16;
export const DEFAULT_PROJECT_TRANSFER_TIMEOUT_MS = 120_000;
export const MAX_PROJECT_TRANSFER_TIMEOUT_MS = 600_000;
export const DEFAULT_PROJECT_CONTENT_MAX_BYTES = 300 * 1024 * 1024;

export const BUNDLE_CONTENT_TYPE = "application/vnd.nuriteo.project-bundle";
export const DIRECT_UPLOAD_HEADERS = new Set([
  "content-length",
  "content-type",
  "host",
  "x-amz-checksum-sha256",
  "x-amz-sdk-checksum-algorithm"
]);
export const RELAY_UPLOAD_HEADERS = new Set([
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

