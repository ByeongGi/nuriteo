import { mutationOptions } from "./browser-mutation.ts";
import type { BrowserMutationOptions } from "./browser-mutation.ts";
import {
  type ApiEmptyResult,
  type ApiResult,
  type DomainRequestOptions,
  invalidResponse,
  requireNoContent,
  validatedResult,
  validatedResultForStatus
} from "./domain.ts";
import { ApiConfigurationError } from "./errors.ts";
import type { ProjectOwner } from "./projects.ts";
import type { ApiClient, ApiResponse } from "./types.ts";
import {
  readBoundedArray,
  readBoundedString,
  readEnum,
  readExactRecord,
  readNullableUtcTimestamp,
  readPositiveInteger,
  readUtcTimestamp,
  readUuidV7
} from "./validation.ts";

const VISIBILITIES = ["unlisted", "public"] as const;
const STATES = ["published", "unpublished"] as const;
const PUBLIC_ID = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u;
const EXAMPLE_ETAG = /^"published-example-v([1-9]\d*)"$/u;
const MAX_GENERATION = 9_223_372_036_854_775_806n;
const MAX_PUBLIC_ITEMS = 100;
const FORK_IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,128}$/u;
const PROJECT_SLUG = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u;

export type PublishedExampleVisibility = (typeof VISIBILITIES)[number];
export type PublishedExampleState = (typeof STATES)[number];

export interface PublishedExample {
  readonly id: string;
  readonly publicId: string;
  readonly name: string;
  readonly visibility: PublishedExampleVisibility;
  readonly state: PublishedExampleState;
  readonly activeVersionId: string;
  readonly generation: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly unpublishedAt: string | null;
}

export interface PublishedExampleVersion {
  readonly id: string;
  readonly projectVersionId: string;
  readonly versionNumber: number;
  readonly createdAt: string;
}

export interface PublishedExampleCreate {
  readonly example: PublishedExample;
  readonly version: PublishedExampleVersion;
}

export interface PublishedExampleVersionMutation {
  readonly version: PublishedExampleVersion;
  readonly generation: number;
}

export interface PublicPublishedExample {
  readonly publicId: string;
  readonly name: string;
  readonly visibility: PublishedExampleVisibility;
  readonly versionNumber: number;
  readonly publishedAt: string;
}

export interface PublicPublishedExampleCollection {
  readonly items: readonly PublicPublishedExample[];
}

export interface PublishedExampleResult extends ApiResult<PublishedExample> {
  readonly etag: string;
}

export interface PublishedExampleCreateResult extends ApiResult<PublishedExampleCreate> {
  readonly etag: string;
  readonly location: string;
}

export interface PublishedExampleVersionMutationResult
  extends ApiResult<PublishedExampleVersionMutation> {
  readonly etag: string;
}

export interface PublishedExampleProjectInput {
  readonly owner: ProjectOwner;
  readonly projectId: string;
}

export interface CreatePublishedExampleInput extends PublishedExampleProjectInput {
  readonly projectVersionId: string;
  readonly name: string;
  readonly visibility: PublishedExampleVisibility;
}

export interface PublishedExampleInput extends PublishedExampleProjectInput {
  readonly exampleId: string;
}

export interface VersionedPublishedExampleInput extends PublishedExampleInput {
  readonly etag: string;
}

export interface AddPublishedExampleVersionInput extends VersionedPublishedExampleInput {
  readonly projectVersionId: string;
}

export interface SelectPublishedExampleVersionInput extends VersionedPublishedExampleInput {
  readonly versionId: string;
}

export interface SetPublishedExampleVisibilityInput extends VersionedPublishedExampleInput {
  readonly visibility: PublishedExampleVisibility;
}

export interface DeletePublishedExampleInput extends VersionedPublishedExampleInput {
  readonly name: string;
}

export interface ListPublicPublishedExamplesInput {
  readonly limit?: number;
}

export interface PublicPublishedExampleInput {
  readonly publicId: string;
}

export interface PublicPublishedExampleVersionInput extends PublicPublishedExampleInput {
  readonly versionNumber: number;
}

export interface ForkedPublishedExampleProject {
  readonly id: string;
  readonly ownerType: "user" | "organization";
  readonly ownerId: string;
  readonly slug: string;
  readonly name: string;
  readonly state: "active";
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface PublishedExampleFork {
  readonly project: ForkedPublishedExampleProject;
  readonly sourceVersionNumber: number;
  readonly idempotentRetry: boolean;
}

export interface ForkPublishedExampleInput extends PublicPublishedExampleInput {
  readonly versionNumber?: number;
  readonly destinationOwner: ProjectOwner;
  readonly slug: string;
  readonly name: string;
  readonly idempotencyKey: string;
}

export interface PublishedExampleForkResult extends ApiResult<PublishedExampleFork> {
  readonly location: string;
}

/**
 * Returns the cookie-free Core API path for the immutable Project Bundle.
 * The normal API client intentionally does not buffer or JSON-decode this
 * potentially large binary response.
 */
export function publicPublishedExampleContentPath(
  input: PublicPublishedExampleInput | PublicPublishedExampleVersionInput
): `/${string}` {
  const publicId = validatePublicId(input.publicId);
  if ("versionNumber" in input) {
    return `/published-examples/${publicId}/versions/${validatePositiveInteger(input.versionNumber, "version number")}/content`;
  }
  return `/published-examples/${publicId}/content`;
}

export async function createPublishedExample(
  client: ApiClient,
  input: CreatePublishedExampleInput,
  options: BrowserMutationOptions
): Promise<PublishedExampleCreateResult> {
  const context = projectContext(input);
  const projectVersionId = validateId(input.projectVersionId);
  const name = validateName(input.name);
  const visibility = validateVisibility(input.visibility);
  const response = await client.post<unknown, unknown>(
    collectionPath(context),
    { projectVersionId, name, visibility },
    mutationOptions(options)
  );
  const parsed = validatedResultForStatus(response, 201, parseCreate);
  if (
    parsed.data.example.generation !== 1 ||
    parsed.data.version.versionNumber !== 1 ||
    parsed.data.example.activeVersionId !== parsed.data.version.id ||
    parsed.data.example.name !== name ||
    parsed.data.example.visibility !== visibility ||
    parsed.data.version.projectVersionId !== projectVersionId
  ) {
    throw invalidResponse(response);
  }
  const etag = validateResponseEtag(response, 1);
  const location = response.headers.get("location");
  const expectedLocation = `/api/v1${itemPath(context, parsed.data.example.id)}`;
  if (location !== expectedLocation) {
    throw invalidResponse(response);
  }
  return { ...parsed, etag, location };
}

export async function addPublishedExampleVersion(
  client: ApiClient,
  input: AddPublishedExampleVersionInput,
  options: BrowserMutationOptions
): Promise<PublishedExampleVersionMutationResult> {
  const context = itemContext(input);
  const expectedGeneration = generationFromEtag(input.etag);
  const projectVersionId = validateId(input.projectVersionId);
  const response = await client.post<unknown, unknown>(
    `${itemPath(context, context.exampleId)}/versions`,
    { projectVersionId },
    mutationOptions(options, { "if-match": input.etag })
  );
  const parsed = validatedResultForStatus(response, 201, parseVersionMutation);
  if (
    BigInt(parsed.data.generation) !== expectedGeneration + 1n ||
    parsed.data.version.projectVersionId !== projectVersionId ||
    response.headers.has("location")
  ) {
    throw invalidResponse(response);
  }
  return { ...parsed, etag: validateResponseEtag(response, parsed.data.generation) };
}

export async function selectPublishedExampleActiveVersion(
  client: ApiClient,
  input: SelectPublishedExampleVersionInput,
  options: BrowserMutationOptions
): Promise<PublishedExampleResult> {
  const versionId = validateId(input.versionId);
  return mutateExample(client, input, options, "active-version", { versionId }, (example) =>
    example.activeVersionId === versionId
  );
}

export async function setPublishedExampleVisibility(
  client: ApiClient,
  input: SetPublishedExampleVisibilityInput,
  options: BrowserMutationOptions
): Promise<PublishedExampleResult> {
  const visibility = validateVisibility(input.visibility);
  return mutateExample(
    client,
    input,
    options,
    undefined,
    { visibility },
    (example) => example.visibility === visibility,
    "PATCH"
  );
}

export function unpublishPublishedExample(
  client: ApiClient,
  input: VersionedPublishedExampleInput,
  options: BrowserMutationOptions
): Promise<PublishedExampleResult> {
  return mutateExample(client, input, options, "unpublish", undefined, (example) =>
    example.state === "unpublished"
  );
}

export function republishPublishedExample(
  client: ApiClient,
  input: VersionedPublishedExampleInput,
  options: BrowserMutationOptions
): Promise<PublishedExampleResult> {
  return mutateExample(client, input, options, "republish", undefined, (example) =>
    example.state === "published"
  );
}

export async function deletePublishedExample(
  client: ApiClient,
  input: DeletePublishedExampleInput,
  options: BrowserMutationOptions
): Promise<ApiEmptyResult> {
  const context = itemContext(input);
  const response = await client.request<unknown, unknown>(
    "DELETE",
    itemPath(context, context.exampleId),
    {
      ...mutationOptions(options, { "if-match": validateEtag(input.etag) }),
      body: { name: validateName(input.name) }
    }
  );
  return requireNoContent(response);
}

export async function listPublicPublishedExamples(
  client: ApiClient,
  input: ListPublicPublishedExamplesInput = {},
  options: DomainRequestOptions = {}
): Promise<ApiResult<PublicPublishedExampleCollection>> {
  const limit = input.limit ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PUBLIC_ITEMS) {
    throw new ApiConfigurationError("The Published Example limit is invalid.");
  }
  return validatedResult(
    await client.get<unknown>(`/published-examples?limit=${limit}`, options),
    parsePublicCollection
  );
}

export async function getPublicPublishedExample(
  client: ApiClient,
  input: PublicPublishedExampleInput,
  options: DomainRequestOptions = {}
): Promise<ApiResult<PublicPublishedExample>> {
  const publicId = validatePublicId(input.publicId);
  return validatedResult(
    await client.get<unknown>(`/published-examples/${publicId}`, options),
    (value) => parsePublic(value, publicId)
  );
}

export async function getPublicPublishedExampleVersion(
  client: ApiClient,
  input: PublicPublishedExampleVersionInput,
  options: DomainRequestOptions = {}
): Promise<ApiResult<PublicPublishedExample>> {
  const publicId = validatePublicId(input.publicId);
  const versionNumber = validatePositiveInteger(input.versionNumber, "version number");
  return validatedResult(
    await client.get<unknown>(
      `/published-examples/${publicId}/versions/${versionNumber}`,
      options
    ),
    (value) => {
      const example = parsePublic(value, publicId);
      if (example.versionNumber !== versionNumber) {
        throw new TypeError("invalid Published Example version");
      }
      return example;
    }
  );
}

export async function forkPublishedExample(
  client: ApiClient,
  input: ForkPublishedExampleInput,
  options: BrowserMutationOptions
): Promise<PublishedExampleForkResult> {
  const publicId = validatePublicId(input.publicId);
  const destinationOwner = validateOwner(input.destinationOwner);
  const slug = validateProjectSlug(input.slug);
  const name = validateName(input.name);
  const idempotencyKey = validateForkIdempotencyKey(input.idempotencyKey);
  const version = input.versionNumber === undefined
    ? ""
    : `/versions/${validatePositiveInteger(input.versionNumber, "version number")}`;
  const response = await client.post<unknown, unknown>(
    `/published-examples/${publicId}${version}/forks`,
    { destinationOwner, slug, name },
    mutationOptions(options, { "idempotency-key": idempotencyKey })
  );
  if (response.status !== 200 && response.status !== 201) {
    throw invalidResponse(response);
  }
  const parsed = validatedResultForStatus(response, response.status, parseFork);
  const expectedStatus = parsed.data.idempotentRetry ? 200 : 201;
  if (
    response.status !== expectedStatus ||
    parsed.data.project.ownerType !== destinationOwner.ownerType ||
    parsed.data.project.ownerId !== destinationOwner.ownerId ||
    parsed.data.project.slug !== slug ||
    parsed.data.project.name !== name ||
    (input.versionNumber !== undefined &&
      parsed.data.sourceVersionNumber !== input.versionNumber)
  ) {
    throw invalidResponse(response);
  }
  const ownerSegment = destinationOwner.ownerType === "user" ? "users" : "organizations";
  const expectedLocation = `/api/v1/workspaces/${ownerSegment}/${destinationOwner.ownerId}/projects/${parsed.data.project.id}`;
  const location = response.headers.get("location");
  if (location !== expectedLocation) {
    throw invalidResponse(response);
  }
  return { ...parsed, location };
}

async function mutateExample(
  client: ApiClient,
  input: VersionedPublishedExampleInput,
  options: BrowserMutationOptions,
  suffix: string | undefined,
  body: unknown,
  matches: (example: PublishedExample) => boolean,
  method: "POST" | "PATCH" = "POST"
): Promise<PublishedExampleResult> {
  const context = itemContext(input);
  const expectedGeneration = generationFromEtag(input.etag);
  const path = `${itemPath(context, context.exampleId)}${
    suffix === undefined ? "" : `/${suffix}`
  }` as `/${string}`;
  const requestOptions = mutationOptions(options, { "if-match": input.etag });
  const response = method === "PATCH"
    ? await client.patch<unknown, unknown>(path, body, requestOptions)
    : await client.post<unknown, unknown>(path, body, requestOptions);
  const parsed = validatedResult(response, parseExample);
  if (
    parsed.data.id !== context.exampleId ||
    BigInt(parsed.data.generation) !== expectedGeneration + 1n ||
    !matches(parsed.data) ||
    response.headers.has("location")
  ) {
    throw invalidResponse(response);
  }
  return { ...parsed, etag: validateResponseEtag(response, parsed.data.generation) };
}

function parseCreate(value: unknown): PublishedExampleCreate {
  const record = readExactRecord(value, ["example", "version"]);
  return { example: parseExample(record.example), version: parseVersion(record.version) };
}

function parseVersionMutation(value: unknown): PublishedExampleVersionMutation {
  const record = readExactRecord(value, ["generation", "version"]);
  return {
    version: parseVersion(record.version),
    generation: readPositiveInteger(record, "generation")
  };
}

function parseExample(value: unknown): PublishedExample {
  const record = readExactRecord(value, [
    "activeVersionId", "createdAt", "generation", "id", "name", "publicId", "state",
    "unpublishedAt", "updatedAt", "visibility"
  ]);
  const result: PublishedExample = {
    id: readUuidV7(record, "id"),
    publicId: readPublicId(record, "publicId"),
    name: readName(record, "name"),
    visibility: readEnum(record, "visibility", VISIBILITIES),
    state: readEnum(record, "state", STATES),
    activeVersionId: readUuidV7(record, "activeVersionId"),
    generation: readPositiveInteger(record, "generation"),
    createdAt: readUtcTimestamp(record, "createdAt"),
    updatedAt: readUtcTimestamp(record, "updatedAt"),
    unpublishedAt: readNullableUtcTimestamp(record, "unpublishedAt")
  };
  const lifecycleMatches = result.state === "published"
    ? result.unpublishedAt === null
    : result.unpublishedAt !== null;
  if (
    !lifecycleMatches ||
    Date.parse(result.createdAt) > Date.parse(result.updatedAt) ||
    (result.unpublishedAt !== null && Date.parse(result.unpublishedAt) > Date.parse(result.updatedAt))
  ) {
    throw new TypeError("invalid Published Example");
  }
  return result;
}

function parseVersion(value: unknown): PublishedExampleVersion {
  const record = readExactRecord(value, ["createdAt", "id", "projectVersionId", "versionNumber"]);
  return {
    id: readUuidV7(record, "id"),
    projectVersionId: readUuidV7(record, "projectVersionId"),
    versionNumber: readPositiveInteger(record, "versionNumber"),
    createdAt: readUtcTimestamp(record, "createdAt")
  };
}

function parsePublicCollection(value: unknown): PublicPublishedExampleCollection {
  const record = readExactRecord(value, ["items"]);
  return {
    items: readBoundedArray(record, "items", MAX_PUBLIC_ITEMS).map((item) => parsePublic(item))
  };
}

function parsePublic(value: unknown, expectedPublicId?: string): PublicPublishedExample {
  const record = readExactRecord(value, [
    "name", "publicId", "publishedAt", "versionNumber", "visibility"
  ]);
  const result: PublicPublishedExample = {
    publicId: readPublicId(record, "publicId"),
    name: readName(record, "name"),
    visibility: readEnum(record, "visibility", VISIBILITIES),
    versionNumber: readPositiveInteger(record, "versionNumber"),
    publishedAt: readUtcTimestamp(record, "publishedAt")
  };
  if (expectedPublicId !== undefined && result.publicId !== expectedPublicId) {
    throw new TypeError("invalid Published Example public identifier");
  }
  return result;
}

function parseFork(value: unknown): PublishedExampleFork {
  const record = readExactRecord(value, ["idempotentRetry", "project", "sourceVersionNumber"]);
  if (typeof record.idempotentRetry !== "boolean") {
    throw new TypeError("invalid Published Example fork retry state");
  }
  return {
    project: parseForkedProject(record.project),
    sourceVersionNumber: readPositiveInteger(record, "sourceVersionNumber"),
    idempotentRetry: record.idempotentRetry
  };
}

function parseForkedProject(value: unknown): ForkedPublishedExampleProject {
  const record = readExactRecord(value, [
    "createdAt", "id", "name", "ownerId", "ownerType", "slug", "state", "updatedAt",
    "version"
  ]);
  const ownerType = readEnum(record, "ownerType", ["user", "organization"] as const);
  const state = readEnum(record, "state", ["active"] as const);
  const createdAt = readUtcTimestamp(record, "createdAt");
  const updatedAt = readUtcTimestamp(record, "updatedAt");
  if (Date.parse(createdAt) > Date.parse(updatedAt)) {
    throw new TypeError("invalid forked Project timestamp order");
  }
  return {
    id: readUuidV7(record, "id"),
    ownerType,
    ownerId: readUuidV7(record, "ownerId"),
    slug: readProjectSlug(record, "slug"),
    name: readName(record, "name"),
    state,
    version: readPositiveInteger(record, "version"),
    createdAt,
    updatedAt
  };
}

interface ProjectContext {
  readonly owner: ProjectOwner;
  readonly projectId: string;
}

interface ItemContext extends ProjectContext {
  readonly exampleId: string;
}

function projectContext(input: PublishedExampleProjectInput): ProjectContext {
  const owner = validateOwner(input.owner);
  return { owner, projectId: validateId(input.projectId) };
}

function itemContext(input: PublishedExampleInput): ItemContext {
  return { ...projectContext(input), exampleId: validateId(input.exampleId) };
}

function validateOwner(owner: ProjectOwner): ProjectOwner {
  if (
    typeof owner !== "object" ||
    owner === null ||
    (owner.ownerType !== "user" && owner.ownerType !== "organization")
  ) {
    throw new ApiConfigurationError("The Published Example owner is invalid.");
  }
  return { ownerType: owner.ownerType, ownerId: validateId(owner.ownerId) } as ProjectOwner;
}

function validateId(value: string): string {
  try {
    return readUuidV7({ value }, "value");
  } catch {
    throw new ApiConfigurationError("The Published Example identifier is invalid.");
  }
}

function validateName(value: string): string {
  try {
    return readName({ value }, "value");
  } catch {
    throw new ApiConfigurationError("The Published Example name is invalid.");
  }
}

function readName(record: Record<string, unknown>, key: string): string {
  const value = readBoundedString(record, key, 800, { maxCharacters: 200 });
  if (value !== value.trim()) {
    throw new TypeError("invalid Published Example name");
  }
  return value;
}

function validateVisibility(value: PublishedExampleVisibility): PublishedExampleVisibility {
  if (!VISIBILITIES.includes(value)) {
    throw new ApiConfigurationError("The Published Example visibility is invalid.");
  }
  return value;
}

function validatePublicId(value: string): string {
  if (typeof value !== "string" || !PUBLIC_ID.test(value)) {
    throw new ApiConfigurationError("The Published Example public identifier is invalid.");
  }
  return value;
}

function readPublicId(record: Record<string, unknown>, key: string): string {
  const value = readBoundedString(record, key, 43);
  if (!PUBLIC_ID.test(value)) {
    throw new TypeError("invalid Published Example public identifier");
  }
  return value;
}

function validatePositiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new ApiConfigurationError(`The Published Example ${label} is invalid.`);
  }
  return value;
}

function validateProjectSlug(value: string): string {
  try {
    return readProjectSlug({ value }, "value");
  } catch {
    throw new ApiConfigurationError("The forked Project slug is invalid.");
  }
}

function readProjectSlug(record: Record<string, unknown>, key: string): string {
  const value = readBoundedString(record, key, 63);
  if (!PROJECT_SLUG.test(value)) {
    throw new TypeError("invalid Project slug");
  }
  return value;
}

function validateForkIdempotencyKey(value: string): string {
  if (typeof value !== "string" || !FORK_IDEMPOTENCY_KEY.test(value)) {
    throw new ApiConfigurationError("The Published Example fork idempotency key is invalid.");
  }
  return value;
}

function validateEtag(value: string): string {
  generationFromEtag(value);
  return value;
}

function generationFromEtag(value: string): bigint {
  if (typeof value !== "string" || value.length > 48) {
    throw new ApiConfigurationError("The Published Example validator is invalid.");
  }
  const match = value.match(EXAMPLE_ETAG);
  if (match === null) {
    throw new ApiConfigurationError("The Published Example validator is invalid.");
  }
  const generation = BigInt(match[1] as string);
  if (generation > MAX_GENERATION || value !== `"published-example-v${generation}"`) {
    throw new ApiConfigurationError("The Published Example validator is invalid.");
  }
  return generation;
}

function validateResponseEtag(response: ApiResponse<unknown>, generation: number): string {
  const etag = response.headers.get("etag");
  if (etag !== `"published-example-v${generation}"`) {
    throw invalidResponse(response);
  }
  return etag;
}

function collectionPath(context: ProjectContext): `/${string}` {
  const ownerSegment = context.owner.ownerType === "user" ? "users" : "organizations";
  return `/workspaces/${ownerSegment}/${context.owner.ownerId}/projects/${context.projectId}/published-examples`;
}

function itemPath(context: ProjectContext, exampleId: string): `/${string}` {
  return `${collectionPath(context)}/${validateId(exampleId)}`;
}
