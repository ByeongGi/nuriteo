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

const DEFAULT_PAGE_SIZE = 50;
const MAX_COLLECTION_ITEMS = 100;
const MAX_CURSOR_BYTES = 2_048;
const PROJECT_STATES = ["active", "archived"] as const;
const PROJECT_LIST_STATES = ["active", "archived", "all"] as const;
const PROJECT_ROLES = ["read", "write", "admin"] as const;
const PROJECT_ETAG = /^"project-v([1-9]\d*)"$/u;
const MAX_PROJECT_VERSION = 9_223_372_036_854_775_806n;
const PROJECT_SLUG = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const textEncoder = new TextEncoder();

export type ProjectOwner = PersonalProjectOwner | OrganizationProjectOwner;
export type ProjectState = (typeof PROJECT_STATES)[number];
export type ProjectListState = (typeof PROJECT_LIST_STATES)[number];
export type ProjectRole = (typeof PROJECT_ROLES)[number];

export interface PersonalProjectOwner {
  readonly ownerType: "user";
  readonly ownerId: string;
}

export interface OrganizationProjectOwner {
  readonly ownerType: "organization";
  readonly ownerId: string;
}

export interface Project {
  readonly id: string;
  readonly ownerType: ProjectOwner["ownerType"];
  readonly ownerId: string;
  readonly storageScopeId: string;
  readonly slug: string;
  readonly name: string;
  readonly state: ProjectState;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archivedAt: string | null;
  readonly version: number;
}

export interface ProjectResult extends ApiResult<Project> {
  readonly etag: string;
  readonly location?: string;
}

export interface ProjectCollection {
  readonly items: readonly Project[];
  readonly nextCursor: string | null;
}

export interface DirectProjectRole {
  readonly projectId: string;
  readonly organizationId: string;
  readonly userId: string;
  readonly role: ProjectRole;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly version: number;
}

export interface DirectProjectRoleCollection {
  readonly items: readonly DirectProjectRole[];
  readonly nextCursor: string | null;
}

export interface ProjectRoleMutation {
  readonly changed: boolean;
  readonly grant: DirectProjectRole | null;
  readonly projectVersion: number;
}

export interface ProjectRoleMutationResult extends ApiResult<ProjectRoleMutation> {
  readonly etag: string;
}

export interface CreateProjectInput {
  readonly owner: ProjectOwner;
  readonly slug: string;
  readonly name: string;
}

export interface ListProjectsInput {
  readonly owner: ProjectOwner;
  readonly state?: ProjectListState;
  readonly pageSize?: number;
  readonly cursor?: string;
}

export interface ProjectInput {
  readonly owner: ProjectOwner;
  readonly projectId: string;
}

export interface RenameProjectInput extends ProjectInput {
  readonly name: string;
  readonly etag: string;
}

export interface VersionedProjectInput extends ProjectInput {
  readonly etag: string;
}

export interface DeleteProjectInput extends VersionedProjectInput {
  readonly name: string;
}

export interface ListDirectProjectRolesInput extends ProjectInput {
  readonly pageSize?: number;
  readonly cursor?: string;
}

export interface GrantDirectProjectRoleInput extends VersionedProjectInput {
  readonly userId: string;
  readonly role: ProjectRole;
}

export interface ChangeDirectProjectRoleInput extends GrantDirectProjectRoleInput {}

export interface RevokeDirectProjectRoleInput extends VersionedProjectInput {
  readonly userId: string;
}

export async function createProject(
  client: ApiClient,
  input: CreateProjectInput,
  options: BrowserMutationOptions
): Promise<ProjectResult> {
  const owner = validateOwner(input.owner);
  const response = await client.post<unknown, unknown>(
    projectCollectionPath(owner),
    { slug: validateSlug(input.slug), name: validateName(input.name) },
    mutationOptions(options)
  );
  return projectResult(response, 201, owner, true);
}

export async function listProjects(
  client: ApiClient,
  input: ListProjectsInput,
  options: DomainRequestOptions = {}
): Promise<ApiResult<ProjectCollection>> {
  const owner = validateOwner(input.owner);
  const path = withListQuery(projectCollectionPath(owner), input, true);
  const response = await client.get<unknown>(path, options);
  return validatedResult(response, (value) => parseProjectCollection(value, owner));
}

export async function getProject(
  client: ApiClient,
  input: ProjectInput,
  options: DomainRequestOptions = {}
): Promise<ProjectResult> {
  const owner = validateOwner(input.owner);
  const projectId = validateId(input.projectId);
  const response = await client.get<unknown>(projectPath(owner, projectId), options);
  return projectResult(response, 200, owner, false, projectId);
}

export async function renameProject(
  client: ApiClient,
  input: RenameProjectInput,
  options: BrowserMutationOptions
): Promise<ProjectResult> {
  const owner = validateOwner(input.owner);
  const projectId = validateId(input.projectId);
  const response = await client.patch<unknown, unknown>(
    projectPath(owner, projectId),
    { name: validateName(input.name) },
    mutationOptions(options, { "if-match": validateProjectEtag(input.etag) })
  );
  return projectResult(response, 200, owner, false, projectId);
}

export function archiveProject(
  client: ApiClient,
  input: VersionedProjectInput,
  options: BrowserMutationOptions
): Promise<ProjectResult> {
  return changeProjectLifecycle(client, input, options, "archive");
}

export function restoreProject(
  client: ApiClient,
  input: VersionedProjectInput,
  options: BrowserMutationOptions
): Promise<ProjectResult> {
  return changeProjectLifecycle(client, input, options, "restore");
}

export async function deleteProject(
  client: ApiClient,
  input: DeleteProjectInput,
  options: BrowserMutationOptions
): Promise<ApiEmptyResult> {
  const owner = validateOwner(input.owner);
  const response = await client.request<unknown, unknown>(
    "DELETE",
    projectPath(owner, input.projectId),
    {
      ...mutationOptions(options, { "if-match": validateProjectEtag(input.etag) }),
      body: { name: validateName(input.name) }
    }
  );
  return requireNoContent(response);
}

export async function listDirectProjectRoles(
  client: ApiClient,
  input: ListDirectProjectRolesInput,
  options: DomainRequestOptions = {}
): Promise<ApiResult<DirectProjectRoleCollection>> {
  const owner = validateOrganizationOwner(input.owner);
  const path = withListQuery(`${projectPath(owner, input.projectId)}/roles`, input, false);
  const response = await client.get<unknown>(path, options);
  return validatedResult(response, (value) =>
    parseDirectProjectRoleCollection(value, owner.ownerId, validateId(input.projectId))
  );
}

export async function grantDirectProjectRole(
  client: ApiClient,
  input: GrantDirectProjectRoleInput,
  options: BrowserMutationOptions
): Promise<ProjectRoleMutationResult> {
  const owner = validateOrganizationOwner(input.owner);
  const response = await client.post<unknown, unknown>(
    `${projectPath(owner, input.projectId)}/roles`,
    { userId: validateId(input.userId), role: validateProjectRole(input.role) },
    mutationOptions(options, { "if-match": validateProjectEtag(input.etag) })
  );
  return projectRoleMutationResult(response, 201, {
    organizationId: owner.ownerId,
    projectId: validateId(input.projectId),
    userId: validateId(input.userId),
    grant: "required"
  });
}

export async function changeDirectProjectRole(
  client: ApiClient,
  input: ChangeDirectProjectRoleInput,
  options: BrowserMutationOptions
): Promise<ProjectRoleMutationResult> {
  const owner = validateOrganizationOwner(input.owner);
  const response = await client.patch<unknown, unknown>(
    directProjectRolePath(owner, input.projectId, input.userId),
    { role: validateProjectRole(input.role) },
    mutationOptions(options, { "if-match": validateProjectEtag(input.etag) })
  );
  return projectRoleMutationResult(response, 200, {
    organizationId: owner.ownerId,
    projectId: validateId(input.projectId),
    userId: validateId(input.userId),
    grant: "required"
  });
}

export async function revokeDirectProjectRole(
  client: ApiClient,
  input: RevokeDirectProjectRoleInput,
  options: BrowserMutationOptions
): Promise<ProjectRoleMutationResult> {
  const owner = validateOrganizationOwner(input.owner);
  const response = await client.delete<unknown>(
    directProjectRolePath(owner, input.projectId, input.userId),
    mutationOptions(options, { "if-match": validateProjectEtag(input.etag) })
  );
  return projectRoleMutationResult(response, 200, {
    organizationId: owner.ownerId,
    projectId: validateId(input.projectId),
    userId: validateId(input.userId),
    grant: "absent"
  });
}

async function changeProjectLifecycle(
  client: ApiClient,
  input: VersionedProjectInput,
  options: BrowserMutationOptions,
  action: "archive" | "restore"
): Promise<ProjectResult> {
  const owner = validateOwner(input.owner);
  const projectId = validateId(input.projectId);
  const response = await client.post<unknown, undefined>(
    `${projectPath(owner, projectId)}/${action}`,
    undefined,
    mutationOptions(options, { "if-match": validateProjectEtag(input.etag) })
  );
  return projectResult(response, 200, owner, false, projectId);
}

function projectResult(
  response: ApiResponse<unknown>,
  status: 200 | 201,
  owner: ProjectOwner,
  requireLocation: boolean,
  expectedProjectId?: string
): ProjectResult {
  const parsed = validatedResultForStatus(response, status, (value) => parseProject(value, owner));
  if (expectedProjectId !== undefined && parsed.data.id !== expectedProjectId) {
    throw invalidResponse(response);
  }
  const etag = validateResponseEtag(response, parsed.data.version);
  const location = response.headers.get("location");
  const expectedLocation = `/api/v1${projectPath(owner, parsed.data.id)}`;
  if ((requireLocation && location !== expectedLocation) || (!requireLocation && location !== null)) {
    throw invalidResponse(response);
  }
  return { ...parsed, etag, ...(location === null ? {} : { location }) };
}

function projectRoleMutationResult(
  response: ApiResponse<unknown>,
  status: 200 | 201,
  expected: ExpectedRoleMutation
): ProjectRoleMutationResult {
  const parsed = validatedResultForStatus(response, status, (value) =>
    parseProjectRoleMutation(value, expected)
  );
  return {
    ...parsed,
    etag: validateResponseEtag(response, parsed.data.projectVersion)
  };
}

function parseProject(value: unknown, expectedOwner?: ProjectOwner): Project {
  const record = readExactRecord(value, [
    "archivedAt", "createdAt", "id", "name", "ownerId", "ownerType", "slug",
    "state", "storageScopeId", "updatedAt", "version"
  ]);
  const ownerType = readEnum(record, "ownerType", ["user", "organization"] as const);
  const result: Project = {
    id: readUuidV7(record, "id"),
    ownerType,
    ownerId: readUuidV7(record, "ownerId"),
    storageScopeId: readUuidV7(record, "storageScopeId"),
    slug: readBoundedString(record, "slug", 63),
    name: readBoundedString(record, "name", 800, { maxCharacters: 200 }),
    state: readEnum(record, "state", PROJECT_STATES),
    createdAt: readUtcTimestamp(record, "createdAt"),
    updatedAt: readUtcTimestamp(record, "updatedAt"),
    archivedAt: readNullableUtcTimestamp(record, "archivedAt"),
    version: readPositiveInteger(record, "version")
  };
  const ownerMatches = expectedOwner === undefined ||
    (result.ownerType === expectedOwner.ownerType && result.ownerId === expectedOwner.ownerId);
  const lifecycleMatches = result.state === "active"
    ? result.archivedAt === null
    : result.archivedAt !== null;
  if (
    !PROJECT_SLUG.test(result.slug) ||
    !ownerMatches ||
    !lifecycleMatches ||
    Date.parse(result.createdAt) > Date.parse(result.updatedAt) ||
    (result.archivedAt !== null && Date.parse(result.updatedAt) < Date.parse(result.archivedAt))
  ) {
    throw new TypeError("invalid Project");
  }
  return result;
}

function parseProjectCollection(value: unknown, owner: ProjectOwner): ProjectCollection {
  const record = readExactRecord(value, ["items", "nextCursor"]);
  return {
    items: readBoundedArray(record, "items", MAX_COLLECTION_ITEMS).map((item) =>
      parseProject(item, owner)
    ),
    nextCursor: readNullableCursor(record, "nextCursor")
  };
}

interface ExpectedRoleContext {
  readonly organizationId: string;
  readonly projectId: string;
  readonly userId?: string;
}

interface ExpectedRoleMutation extends ExpectedRoleContext {
  readonly grant: "required" | "absent";
}

function parseDirectProjectRole(
  value: unknown,
  expected: ExpectedRoleContext
): DirectProjectRole {
  const record = readExactRecord(value, [
    "createdAt", "organizationId", "projectId", "role", "updatedAt", "userId", "version"
  ]);
  const result: DirectProjectRole = {
    projectId: readUuidV7(record, "projectId"),
    organizationId: readUuidV7(record, "organizationId"),
    userId: readUuidV7(record, "userId"),
    role: readEnum(record, "role", PROJECT_ROLES),
    createdAt: readUtcTimestamp(record, "createdAt"),
    updatedAt: readUtcTimestamp(record, "updatedAt"),
    version: readPositiveInteger(record, "version")
  };
  if (
    result.organizationId !== expected.organizationId ||
    result.projectId !== expected.projectId ||
    (expected.userId !== undefined && result.userId !== expected.userId) ||
    Date.parse(result.createdAt) > Date.parse(result.updatedAt)
  ) {
    throw new TypeError("invalid direct Project role");
  }
  return result;
}

function parseDirectProjectRoleCollection(
  value: unknown,
  organizationId: string,
  projectId: string
): DirectProjectRoleCollection {
  const record = readExactRecord(value, ["items", "nextCursor"]);
  return {
    items: readBoundedArray(record, "items", MAX_COLLECTION_ITEMS).map((item) =>
      parseDirectProjectRole(item, { organizationId, projectId })
    ),
    nextCursor: readNullableCursor(record, "nextCursor")
  };
}

function parseProjectRoleMutation(
  value: unknown,
  expected: ExpectedRoleMutation
): ProjectRoleMutation {
  const record = readExactRecord(value, ["changed", "grant", "projectVersion"]);
  const changed = record.changed;
  if (typeof changed !== "boolean") {
    throw new TypeError("invalid role mutation");
  }
  const grant = record.grant === null ? null : parseDirectProjectRole(record.grant, expected);
  if (
    (expected.grant === "required" && grant === null) ||
    (expected.grant === "absent" && grant !== null) ||
    (!changed && grant !== null)
  ) {
    throw new TypeError("invalid role mutation");
  }
  return {
    changed,
    grant,
    projectVersion: readPositiveInteger(record, "projectVersion")
  };
}

function withListQuery(
  path: `/${string}`,
  input: { readonly state?: ProjectListState; readonly pageSize?: number; readonly cursor?: string },
  allowState: boolean
): `/${string}` {
  const query = new URLSearchParams();
  if (input.state !== undefined) {
    if (!allowState || !PROJECT_LIST_STATES.includes(input.state)) {
      throw new ApiConfigurationError("The Project state filter is invalid.");
    }
    query.set("state", input.state);
  }
  const pageSize = input.pageSize ?? DEFAULT_PAGE_SIZE;
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_COLLECTION_ITEMS) {
    throw new ApiConfigurationError("The Project page size is invalid.");
  }
  query.set("pageSize", String(pageSize));
  if (input.cursor !== undefined) {
    query.set("cursor", validateCursor(input.cursor));
  }
  return `${path}?${query.toString()}`;
}

function readNullableCursor(record: Record<string, unknown>, key: string): string | null {
  if (record[key] === null) {
    return null;
  }
  return validateCursor(readBoundedString(record, key, MAX_CURSOR_BYTES));
}

function validateCursor(value: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    textEncoder.encode(value).byteLength > MAX_CURSOR_BYTES ||
    /[\u0000-\u0020\u007f]/u.test(value)
  ) {
    throw new ApiConfigurationError("The Project cursor is invalid.");
  }
  return value;
}

function validateOwner(owner: ProjectOwner): ProjectOwner {
  if (
    typeof owner !== "object" ||
    owner === null ||
    (owner.ownerType !== "user" && owner.ownerType !== "organization")
  ) {
    throw new ApiConfigurationError("The Project owner is invalid.");
  }
  return { ownerType: owner.ownerType, ownerId: validateId(owner.ownerId) };
}

function validateOrganizationOwner(owner: ProjectOwner): OrganizationProjectOwner {
  const validated = validateOwner(owner);
  if (validated.ownerType !== "organization") {
    throw new ApiConfigurationError("Direct Project roles require an Organization owner.");
  }
  return validated;
}

function validateId(value: string): string {
  try {
    return readUuidV7({ value }, "value");
  } catch {
    throw new ApiConfigurationError("The identifier is invalid.");
  }
}

function validateSlug(value: string): string {
  if (typeof value !== "string" || !PROJECT_SLUG.test(value)) {
    throw new ApiConfigurationError("The Project slug is invalid.");
  }
  return value;
}

function validateName(value: string): string {
  if (
    typeof value !== "string" ||
    value.startsWith(" ") ||
    value.endsWith(" ") ||
    [...value].length < 1 ||
    [...value].length > 200 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new ApiConfigurationError("The Project name is invalid.");
  }
  return value;
}

function validateProjectRole(value: ProjectRole): ProjectRole {
  if (!PROJECT_ROLES.includes(value)) {
    throw new ApiConfigurationError("The Project role is invalid.");
  }
  return value;
}

function validateProjectEtag(value: string): string {
  if (typeof value !== "string" || value.length > 32) {
    throw new ApiConfigurationError("The Project validator is invalid.");
  }
  const match = value.match(PROJECT_ETAG);
  if (match === null) {
    throw new ApiConfigurationError("The Project validator is invalid.");
  }
  const version = BigInt(match[1] as string);
  if (version > MAX_PROJECT_VERSION || value !== `"project-v${version}"`) {
    throw new ApiConfigurationError("The Project validator is invalid.");
  }
  return value;
}

function validateResponseEtag(response: ApiResponse<unknown>, version: number): string {
  const etag = response.headers.get("etag");
  if (etag?.match(PROJECT_ETAG)?.[1] !== String(version)) {
    throw invalidResponse(response);
  }
  return etag;
}

function projectCollectionPath(owner: ProjectOwner): `/${string}` {
  const ownerSegment = owner.ownerType === "user" ? "users" : "organizations";
  return `/workspaces/${ownerSegment}/${owner.ownerId}/projects`;
}

function projectPath(owner: ProjectOwner, projectId: string): `/${string}` {
  return `${projectCollectionPath(owner)}/${validateId(projectId)}`;
}

function directProjectRolePath(
  owner: OrganizationProjectOwner,
  projectId: string,
  userId: string
): `/${string}` {
  return `${projectPath(owner, projectId)}/roles/${validateId(userId)}`;
}
