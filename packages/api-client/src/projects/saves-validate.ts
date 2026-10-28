
import { validateHeaderValue } from "../browser-mutation.ts";

import { invalidResponse } from "../domain.ts";
import { ApiAbortError, ApiConfigurationError, ApiError, ApiInvalidResponseError, ApiTimeoutError } from "../errors.ts";

import type { ProjectOwner } from "./projects.ts";
import type { ApiResponse, FieldViolation, ProblemDetails } from "../types.ts";
import { readBoolean, readBoundedArray, readBoundedString, readExactRecord, readPositiveInteger, readUtcTimestamp, readUuidV7 } from "../validation.ts";
import type { SavePart, SaveProjectInput } from "./saves.ts";
import { SAVE_MAX_PARTS, SAVE_PART_BATCH_LIMIT } from "./saves.ts";
import type { DirectSaveUploadCapability, ProjectContentDescriptor, ProjectContentSink, ProjectTransferErrorKind, ProjectTransferPhase, RelaySaveUploadCapability, RelayUploadIdentity, SaveCommit, SaveReconciliation, SaveSession, SaveSessionInput, SaveUploadCapability, SaveUploadHeader, TransferRequestOptions, UploadSaveCapabilityOptions } from "./saves.ts";
import { BUNDLE_CONTENT_TYPE, CONTENT_ETAG, DEFAULT_PROJECT_TRANSFER_TIMEOUT_MS, DIRECT_UPLOAD_HEADERS, HEADER_NAME, IDEMPOTENCY_KEY, MAX_CAPABILITY_PATH_BYTES, MAX_CAPABILITY_URL_BYTES, MAX_HEADER_BYTES, MAX_PROBLEM_BYTES, MAX_PROJECT_TRANSFER_TIMEOUT_MS, MAX_PROJECT_VERSION, MAX_TRANSFER_BYTES, MAX_UPLOAD_HEADERS, PROJECT_ETAG, ProjectTransferError, RELAY_UPLOAD_HEADERS, SAVE_MULTIPART_PART_BYTES, SHA256_BASE64URL, SHA256_HEX, UUID_V7, encoder } from "./saves.ts";

export function validateUploadPart(part: SavePart): SavePart {
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

export function validatePartBatch(parts: readonly SavePart[]): readonly SavePart[] {
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

export function saveContext(input: SaveProjectInput): {
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

export function saveSessionContext(input: SaveSessionInput): ReturnType<typeof saveContext> & {
  readonly sessionId: string;
} {
  return { ...saveContext(input), sessionId: validateUuid(input.sessionId, "Save session ID") };
}

export function validateOwner(owner: ProjectOwner): ProjectOwner {
  if (
    typeof owner !== "object" || owner === null ||
    (owner.ownerType !== "user" && owner.ownerType !== "organization")
  ) {
    throw new ApiConfigurationError("The Project owner is invalid.");
  }
  return { ownerType: owner.ownerType, ownerId: validateUuid(owner.ownerId, "owner ID") };
}

export function validateUuid(value: string, label: string): string {
  if (typeof value !== "string" || !UUID_V7.test(value)) {
    throw new ApiConfigurationError(`The ${label} is invalid.`);
  }
  return value;
}

export function validateProjectEtag(value: string): string {
  const match = typeof value === "string" ? value.match(PROJECT_ETAG) : null;
  const version = match?.[1];
  if (version === undefined || !Number.isSafeInteger(Number(version)) || Number(version) > MAX_PROJECT_VERSION) {
    throw new ApiConfigurationError("The Project ETag is invalid.");
  }
  return value;
}

export function validateIdempotencyKey(value: string): string {
  if (typeof value !== "string" || !IDEMPOTENCY_KEY.test(value)) {
    throw new ApiConfigurationError("The Save idempotency key is invalid.");
  }
  return value;
}

export function validateSha256Hex(value: string): string {
  if (typeof value !== "string" || !SHA256_HEX.test(value)) {
    throw new ApiConfigurationError("The SHA-256 digest is invalid.");
  }
  return value;
}

export function readTransferSize(value: number, label: string, allowZero: boolean): number {
  if (
    !Number.isSafeInteger(value) || value < (allowZero ? 0 : 1) || value > MAX_TRANSFER_BYTES
  ) {
    throw new ApiConfigurationError(`The ${label} is invalid.`);
  }
  return value;
}

export function readCount(value: number, maximum: number, label: string, allowZero = false): number {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1) || value > maximum) {
    throw new ApiConfigurationError(`The ${label} is invalid.`);
  }
  return value;
}

export function validateParts(parts: readonly SavePart[], totalBytes?: number): readonly SavePart[] {
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

export function partRequest(part: SavePart): { partNumber: number; expectedBytes: number; sha256: string } {
  return {
    partNumber: part.partNumber,
    expectedBytes: part.expectedBytes,
    sha256: hexToBase64(part.sha256)
  };
}

export function parseSaveSession(
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

export interface UploadCapabilityExpectation {
  readonly context: ReturnType<typeof saveContext>;
  readonly sessionId: string;
  readonly partNumber: number;
  readonly uploadKind: "single" | "part";
}

export interface RelayUploadExpectation extends UploadCapabilityExpectation {
  readonly csrfToken: string;
}

export function parseUploadCapability(
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

export function parseDirectUploadCapability(value: unknown): DirectSaveUploadCapability {
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

export function parseRelayUploadCapability(
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

export function parseUploadHeaders(
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

export function validateDirectUploadHeaders(
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

export function validateRelayUploadHeaders(headers: readonly SaveUploadHeader[]): void {
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

export function validateUploadCapabilityInput(
  value: unknown,
  expectation?: UploadCapabilityExpectation
): SaveUploadCapability {
  try {
    return parseUploadCapability(value, expectation);
  } catch {
    throw new ApiConfigurationError("The upload capability is invalid.");
  }
}

export function validateCapabilityUrl(value: string): URL {
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

export function validateRelayPath(
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

export function relayUploadPath(expectation: UploadCapabilityExpectation): string {
  const base = `/api/v1${expectation.context.path}/save-sessions/${expectation.sessionId}/upload`;
  return expectation.uploadKind === "single"
    ? base
    : `${base}/parts/${expectation.partNumber}`;
}

export function readRelayUploadExpectation(
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

export function validateTransferOptionKeys(
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

export function parseSaveCommit(value: unknown): SaveCommit {
  const record = readExactRecord(value, ["bundleId", "projectVersion"]);
  return {
    bundleId: readUuidV7(record, "bundleId"),
    projectVersion: readPositiveInteger(record, "projectVersion", MAX_PROJECT_VERSION)
  };
}

export function parseReconciliation(value: unknown): SaveReconciliation {
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

export function parseContentDescriptor(
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

export function validateContentDescriptorInput(value: unknown): ProjectContentDescriptor {
  try {
    return parseContentDescriptor(value);
  } catch {
    throw new ApiConfigurationError("The Project content descriptor is invalid.");
  }
}

export function readNonNegativeInteger(
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

export function validateReceiptEtag(value: string | null | undefined): string {
  if (
    typeof value !== "string" || encoder.encode(value).byteLength > 512 ||
    !/^"[\x21\x23-\x7e\x80-\xff]+"$/u.test(value)
  ) {
    throw new ApiConfigurationError("The upload receipt ETag is invalid.");
  }
  return value;
}

export function requireSingleHeader(response: ApiResponse<unknown>, name: string): string {
  const value = response.headers.get(name);
  if (value === null || value.includes(",")) throw invalidResponse(response);
  return value;
}

export function normalizeTransferLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_TRANSFER_BYTES) {
    throw new ApiConfigurationError("The Project content byte limit is invalid.");
  }
  return value;
}

export function normalizeTransferTimeout(value: number | undefined): number {
  const timeout = value ?? DEFAULT_PROJECT_TRANSFER_TIMEOUT_MS;
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > MAX_PROJECT_TRANSFER_TIMEOUT_MS) {
    throw new ApiConfigurationError("The Project transfer timeout is invalid.");
  }
  return timeout;
}

export function normalizeBaseUrl(value: string | undefined): string {
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

export async function withTransferDeadline<Result>(
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

export function uploadCapabilityChecksum(capability: SaveUploadCapability): string | undefined {
  return capability.headers.find(
    (header) => header.name === (
      capability.transport === "direct"
        ? "x-amz-checksum-sha256"
        : "x-nuriteo-content-sha256"
    )
  )?.value;
}

export function transferAbortError(
  phase: ProjectTransferPhase,
  _signal: AbortSignal,
  source?: "external" | "timeout"
): ProjectTransferError {
  return source === "timeout"
    ? new ProjectTransferError(phase, "timeout", { retryable: true })
    : new ProjectTransferError(phase, "aborted");
}

export function normalizeTransferFailure(error: unknown): ProjectTransferError {
  if (error instanceof ProjectTransferError) return error;
  if (error instanceof ApiTimeoutError) return new ProjectTransferError("download", "timeout", { retryable: true });
  if (error instanceof ApiAbortError) return new ProjectTransferError("download", "aborted");
  return new ProjectTransferError("download", "transport", { retryable: true });
}

export function validateDownloadResponse(
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

export async function apiErrorFromRawResponse(response: Response): Promise<ApiError> {
  const requestId = response.headers.get("x-request-id")?.trim() || undefined;
  const problem = await readProblemDetails(response);
  return new ApiError(response.status, requestId ?? problem?.request_id, problem);
}

export async function readProblemDetails(response: Response): Promise<ProblemDetails | undefined> {
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

export function parseFieldViolations(value: unknown): readonly FieldViolation[] {
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

export async function cancelBody(body: ReadableStream<Uint8Array> | null): Promise<void> {
  if (body === null) return;
  try {
    await body.cancel();
  } catch {
    // Response cleanup must not replace the stable transfer result.
  }
}

export async function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
  try {
    await reader.cancel();
  } catch {
    // The stable transfer failure remains authoritative.
  }
}

export async function abortSink<Result>(
  sink: ProjectContentSink<Result>,
  reason: ProjectTransferError
): Promise<void> {
  try {
    await sink.abort(reason);
  } catch {
    // The stable transfer failure remains authoritative.
  }
}

export function hexToBase64(hex: string): string {
  const bytes = new Uint8Array(32);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytesToBase64(bytes);
}

export function bytesToBase64(bytes: Uint8Array): string {
  let value = "";
  for (const byte of bytes) value += String.fromCharCode(byte);
  return btoa(value);
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

export function decodeBase64Checksum(value: string): Uint8Array | undefined {
  if (!/^[A-Za-z0-9+/]{43}=$/u.test(value)) return undefined;
  try {
    const decoded = atob(value);
    if (decoded.length !== 32) return undefined;
    return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
  } catch {
    return undefined;
  }
}

export function isRetryableStatus(status: number): boolean {
  return [408, 425, 429, 500, 502, 503, 504].includes(status);
}

export function projectTransferMessage(
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
