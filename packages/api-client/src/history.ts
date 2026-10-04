import { mutationOptions } from "./browser-mutation.ts";
import type { BrowserMutationOptions } from "./browser-mutation.ts";
import {
  type ApiResult,
  type DomainRequestOptions,
  invalidResponse,
  validatedResult
} from "./domain.ts";
import { ApiConfigurationError } from "./errors.ts";
import type { ProjectOwner } from "./projects.ts";
import type { ApiClient, ApiResponse } from "./types.ts";
import {
  readBoolean,
  readBoundedArray,
  readBoundedString,
  readEnum,
  readExactRecord,
  readPositiveInteger,
  readUtcTimestamp,
  readUuidV7
} from "./validation.ts";

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;
const MAX_RECOVERY_CHECKPOINTS = 3;
const MAX_CURSOR_BYTES = 2_048;
const MAX_PROJECT_VERSION = 9_223_372_036_854_775_806n;
const MAX_BUNDLE_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_FILE_COUNT = 100_000;
const PROJECT_ETAG = /^"project-v([1-9]\d*)"$/u;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._-]{16,128}$/u;
const SHA256_HEX = /^[0-9a-f]{64}$/u;
const REFERENCE_KINDS = ["version", "recovery"] as const;
const textEncoder = new TextEncoder();

export type HistoricalReferenceKind = (typeof REFERENCE_KINDS)[number];

export interface ProjectHistoryInput {
  readonly owner: ProjectOwner;
  readonly projectId: string;
}

export interface CreateProjectVersionInput extends ProjectHistoryInput {
  readonly name: string;
  readonly projectEtag: string;
  readonly idempotencyKey: string;
}

export interface ListProjectVersionsInput extends ProjectHistoryInput {
  readonly pageSize?: number;
  readonly cursor?: string;
}

export interface RestoreProjectHistoryInput extends ProjectHistoryInput {
  readonly referenceKind: HistoricalReferenceKind;
  readonly referenceId: string;
  readonly projectEtag: string;
  readonly idempotencyKey: string;
}

export interface ReconcileProjectHistoryInput extends ProjectHistoryInput {
  readonly idempotencyKey: string;
}

export interface ProjectVersion {
  readonly id: string;
  readonly projectId: string;
  readonly bundleId: string;
  readonly name: string;
  readonly createdByUserId: string;
  readonly sourceProjectVersion: number;
  readonly createdAt: string;
  readonly sha256: string;
  readonly physicalBytes: number;
  readonly logicalBytes: number;
  readonly fileCount: number;
  readonly format: "project-bundle-v1";
}

export interface ProjectVersionCollection {
  readonly items: readonly ProjectVersion[];
  readonly nextCursor: string | null;
}

export interface ProjectVersionCreate {
  readonly version: ProjectVersion;
  readonly idempotentRetry: boolean;
}

export interface ProjectVersionCreateResult extends ApiResult<ProjectVersionCreate> {
  readonly replayed: boolean;
}

export interface RecoveryCheckpoint {
  readonly id: string;
  readonly projectId: string;
  readonly bundleId: string;
  readonly position: number;
  readonly createdByUserId: string;
  readonly createdAt: string;
  readonly sha256: string;
  readonly physicalBytes: number;
  readonly logicalBytes: number;
  readonly fileCount: number;
  readonly format: "project-bundle-v1";
}

export interface RecoveryCheckpointCollection {
  readonly items: readonly RecoveryCheckpoint[];
}

export interface ProjectHistoryPromotion {
  readonly operationId: string;
  readonly referenceKind: HistoricalReferenceKind;
  readonly referenceId: string;
  readonly bundleId: string;
  readonly projectVersion: number;
  readonly changed: boolean;
  readonly idempotentRetry: boolean;
}

export interface ProjectHistoryPromotionResult extends ApiResult<ProjectHistoryPromotion> {
  readonly projectEtag: string;
}

export async function createProjectVersion(
  client: ApiClient,
  input: CreateProjectVersionInput,
  options: BrowserMutationOptions
): Promise<ProjectVersionCreateResult> {
  const context = historyContext(input);
  const name = validateVersionName(input.name);
  const projectEtag = validateProjectEtag(input.projectEtag);
  const response = await client.post<unknown, unknown>(
    `${context.path}/versions`,
    { name },
    mutationOptions(options, {
      "if-match": projectEtag,
      "idempotency-key": validateIdempotencyKey(input.idempotencyKey)
    })
  );
  if (response.status !== 200 && response.status !== 201) throw invalidResponse(response);
  const result = parseResponse(response, (value) =>
    parseProjectVersionCreate(
      value,
      context.projectId,
      name,
      projectVersionFromEtag(projectEtag)
    )
  );
  if ((response.status === 200) !== result.data.idempotentRetry) throw invalidResponse(response);
  return { ...result, replayed: response.status === 200 };
}

export async function listProjectVersions(
  client: ApiClient,
  input: ListProjectVersionsInput,
  options: DomainRequestOptions = {}
): Promise<ApiResult<ProjectVersionCollection>> {
  const context = historyContext(input);
  const pageSize = validatePageSize(input.pageSize);
  const query = new URLSearchParams({ pageSize: String(pageSize) });
  if (input.cursor !== undefined) query.set("cursor", validateCursor(input.cursor));
  const response = await client.get<unknown>(`${context.path}/versions?${query.toString()}`, options);
  return validatedResult(response, (value) =>
    parseProjectVersionCollection(value, context.projectId, pageSize)
  );
}

export async function listRecoveryCheckpoints(
  client: ApiClient,
  input: ProjectHistoryInput,
  options: DomainRequestOptions = {}
): Promise<ApiResult<RecoveryCheckpointCollection>> {
  const context = historyContext(input);
  const response = await client.get<unknown>(`${context.path}/recovery-checkpoints`, options);
  return validatedResult(response, (value) => parseRecoveryCollection(value, context.projectId));
}

export async function restoreProjectHistory(
  client: ApiClient,
  input: RestoreProjectHistoryInput,
  options: BrowserMutationOptions
): Promise<ProjectHistoryPromotionResult> {
  const context = historyContext(input);
  const response = await client.post<unknown, unknown>(
    `${context.path}/history/restore`,
    {
      referenceKind: validateReferenceKind(input.referenceKind),
      referenceId: validateId(input.referenceId, "history reference")
    },
    mutationOptions(options, {
      "if-match": validateProjectEtag(input.projectEtag),
      "idempotency-key": validateIdempotencyKey(input.idempotencyKey)
    })
  );
  return promotionResult(response, input.referenceKind, input.referenceId);
}

export async function reconcileProjectHistory(
  client: ApiClient,
  input: ReconcileProjectHistoryInput,
  options: DomainRequestOptions = {}
): Promise<ProjectHistoryPromotionResult> {
  const context = historyContext(input);
  const headers = new Headers({ "idempotency-key": validateIdempotencyKey(input.idempotencyKey) });
  const response = await client.get<unknown>(`${context.path}/history/restore`, {
    ...options,
    headers
  });
  return promotionResult(response);
}

function promotionResult(
  response: ApiResponse<unknown>,
  expectedKind?: HistoricalReferenceKind,
  expectedReferenceId?: string
): ProjectHistoryPromotionResult {
  const result = validatedResult(response, (value) => parsePromotion(value));
  if (
    (expectedKind !== undefined && result.data.referenceKind !== expectedKind) ||
    (expectedReferenceId !== undefined && result.data.referenceId !== expectedReferenceId)
  ) {
    throw invalidResponse(response);
  }
  const projectEtag = response.headers.get("etag");
  if (projectEtag !== `"project-v${result.data.projectVersion}"`) throw invalidResponse(response);
  return { ...result, projectEtag };
}

function parseProjectVersionCreate(
  value: unknown,
  projectId: string,
  expectedName: string,
  expectedSourceProjectVersion: bigint
): ProjectVersionCreate {
  const record = readExactRecord(value, ["idempotentRetry", "version"]);
  const version = parseProjectVersion(record.version, projectId);
  if (
    version.name !== expectedName ||
    BigInt(version.sourceProjectVersion) !== expectedSourceProjectVersion
  ) {
    throw new TypeError("mismatched Project Version create response");
  }
  return {
    version,
    idempotentRetry: readBoolean(record, "idempotentRetry")
  };
}

function parseProjectVersionCollection(
  value: unknown,
  projectId: string,
  pageSize: number
): ProjectVersionCollection {
  const record = readExactRecord(value, ["items", "nextCursor"]);
  return {
    items: readBoundedArray(record, "items", pageSize).map((item) =>
      parseProjectVersion(item, projectId)
    ),
    nextCursor: readNullableCursor(record, "nextCursor")
  };
}

function parseProjectVersion(value: unknown, projectId: string): ProjectVersion {
  const record = readExactRecord(value, [
    "bundleId", "createdAt", "createdByUserId", "fileCount", "format", "id",
    "logicalBytes", "name", "physicalBytes", "projectId", "sha256", "sourceProjectVersion"
  ]);
  const parsed: ProjectVersion = {
    id: readUuidV7(record, "id"),
    projectId: readUuidV7(record, "projectId"),
    bundleId: readUuidV7(record, "bundleId"),
    name: readBoundedString(record, "name", 800, { maxCharacters: 200 }),
    createdByUserId: readUuidV7(record, "createdByUserId"),
    sourceProjectVersion: readPositiveInteger(record, "sourceProjectVersion"),
    createdAt: readUtcTimestamp(record, "createdAt"),
    sha256: readSha256(record),
    physicalBytes: readNonNegativeInteger(record, "physicalBytes", MAX_BUNDLE_BYTES),
    logicalBytes: readNonNegativeInteger(record, "logicalBytes", MAX_BUNDLE_BYTES),
    fileCount: readNonNegativeInteger(record, "fileCount", MAX_FILE_COUNT),
    format: readFormat(record)
  };
  if (parsed.projectId !== projectId || !validVersionName(parsed.name)) {
    throw new TypeError("invalid Project Version");
  }
  return parsed;
}

function parseRecoveryCollection(value: unknown, projectId: string): RecoveryCheckpointCollection {
  const record = readExactRecord(value, ["items"]);
  const items = readBoundedArray(record, "items", MAX_RECOVERY_CHECKPOINTS).map((item) =>
    parseRecoveryCheckpoint(item, projectId)
  );
  if (new Set(items.map((item) => item.position)).size !== items.length) {
    throw new TypeError("duplicate Recovery position");
  }
  return { items };
}

function parseRecoveryCheckpoint(value: unknown, projectId: string): RecoveryCheckpoint {
  const record = readExactRecord(value, [
    "bundleId", "createdAt", "createdByUserId", "fileCount", "format", "id",
    "logicalBytes", "physicalBytes", "position", "projectId", "sha256"
  ]);
  const parsed: RecoveryCheckpoint = {
    id: readUuidV7(record, "id"),
    projectId: readUuidV7(record, "projectId"),
    bundleId: readUuidV7(record, "bundleId"),
    position: readPositiveInteger(record, "position", MAX_RECOVERY_CHECKPOINTS),
    createdByUserId: readUuidV7(record, "createdByUserId"),
    createdAt: readUtcTimestamp(record, "createdAt"),
    sha256: readSha256(record),
    physicalBytes: readNonNegativeInteger(record, "physicalBytes", MAX_BUNDLE_BYTES),
    logicalBytes: readNonNegativeInteger(record, "logicalBytes", MAX_BUNDLE_BYTES),
    fileCount: readNonNegativeInteger(record, "fileCount", MAX_FILE_COUNT),
    format: readFormat(record)
  };
  if (parsed.projectId !== projectId) throw new TypeError("invalid Recovery Project");
  return parsed;
}

function parsePromotion(value: unknown): ProjectHistoryPromotion {
  const record = readExactRecord(value, [
    "bundleId", "changed", "idempotentRetry", "operationId", "projectVersion",
    "referenceId", "referenceKind"
  ]);
  return {
    operationId: readUuidV7(record, "operationId"),
    referenceKind: readEnum(record, "referenceKind", REFERENCE_KINDS),
    referenceId: readUuidV7(record, "referenceId"),
    bundleId: readUuidV7(record, "bundleId"),
    projectVersion: readPositiveInteger(record, "projectVersion"),
    changed: readBoolean(record, "changed"),
    idempotentRetry: readBoolean(record, "idempotentRetry")
  };
}

function parseResponse<T>(response: ApiResponse<unknown>, parser: (value: unknown) => T): ApiResult<T> {
  try {
    return {
      data: parser(response.data),
      status: response.status,
      requestId: response.requestId
    };
  } catch {
    throw invalidResponse(response);
  }
}

function historyContext(input: ProjectHistoryInput): { readonly path: `/${string}`; readonly projectId: string } {
  const owner = validateOwner(input.owner);
  const projectId = validateId(input.projectId, "Project");
  const ownerSegment = owner.ownerType === "user" ? "users" : "organizations";
  return {
    path: `/workspaces/${ownerSegment}/${owner.ownerId}/projects/${projectId}`,
    projectId
  };
}

function validateOwner(owner: ProjectOwner): ProjectOwner {
  if (
    typeof owner !== "object" || owner === null ||
    (owner.ownerType !== "user" && owner.ownerType !== "organization")
  ) {
    throw new ApiConfigurationError("The Project owner is invalid.");
  }
  return { ownerType: owner.ownerType, ownerId: validateId(owner.ownerId, "owner") };
}

function validateId(value: string, label: string): string {
  try {
    return readUuidV7({ value }, "value");
  } catch {
    throw new ApiConfigurationError(`The ${label} identifier is invalid.`);
  }
}

function validateProjectEtag(value: string): string {
  if (typeof value !== "string" || value.length > 32) {
    throw new ApiConfigurationError("The Project validator is invalid.");
  }
  const match = value.match(PROJECT_ETAG);
  if (match === null) throw new ApiConfigurationError("The Project validator is invalid.");
  const version = BigInt(match[1] as string);
  if (version > MAX_PROJECT_VERSION || value !== `"project-v${version}"`) {
    throw new ApiConfigurationError("The Project validator is invalid.");
  }
  return value;
}

function projectVersionFromEtag(value: string): bigint {
  const match = value.match(PROJECT_ETAG);
  if (match === null) throw new ApiConfigurationError("The Project validator is invalid.");
  return BigInt(match[1] as string);
}

function validateIdempotencyKey(value: string): string {
  if (typeof value !== "string" || !IDEMPOTENCY_KEY.test(value)) {
    throw new ApiConfigurationError("The idempotency key is invalid.");
  }
  return value;
}

function validateVersionName(value: string): string {
  if (!validVersionName(value)) {
    throw new ApiConfigurationError("The Project Version name is invalid.");
  }
  return value;
}

function validVersionName(value: unknown): value is string {
  return typeof value === "string" && value === value.normalize("NFC") && value === value.trim() &&
    [...value].length >= 1 && [...value].length <= 200 && !/\p{Cc}/u.test(value);
}

function validateReferenceKind(value: HistoricalReferenceKind): HistoricalReferenceKind {
  if (!REFERENCE_KINDS.includes(value)) {
    throw new ApiConfigurationError("The history reference kind is invalid.");
  }
  return value;
}

function validatePageSize(value: number | undefined): number {
  const pageSize = value ?? DEFAULT_PAGE_SIZE;
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE) {
    throw new ApiConfigurationError("The Project Version page size is invalid.");
  }
  return pageSize;
}

function validateCursor(value: string): string {
  if (
    typeof value !== "string" || value.length === 0 ||
    textEncoder.encode(value).byteLength > MAX_CURSOR_BYTES || /[\u0000-\u0020\u007f]/u.test(value)
  ) {
    throw new ApiConfigurationError("The Project Version cursor is invalid.");
  }
  return value;
}

function readNullableCursor(record: Record<string, unknown>, key: string): string | null {
  if (record[key] === null) return null;
  return validateCursor(readBoundedString(record, key, MAX_CURSOR_BYTES));
}

function readSha256(record: Record<string, unknown>): string {
  const value = readBoundedString(record, "sha256", 64);
  if (!SHA256_HEX.test(value)) throw new TypeError("invalid checksum");
  return value;
}

function readFormat(record: Record<string, unknown>): "project-bundle-v1" {
  return readEnum(record, "format", ["project-bundle-v1"] as const);
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
