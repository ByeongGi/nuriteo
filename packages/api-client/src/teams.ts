import { mutationOptions } from "./browser-mutation.ts";
import type { BrowserMutationOptions } from "./browser-mutation.ts";
import {
  type ApiResult,
  type DomainRequestOptions,
  invalidResponse,
  validatedResult,
  validatedResultForStatus
} from "./domain.ts";
import { ApiConfigurationError } from "./errors.ts";
import type { ProjectRole } from "./projects.ts";
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
const MAX_COLLECTION_ITEMS = 100;
const MAX_CURSOR_BYTES = 2_048;
const MAX_VERSION = 9_223_372_036_854_775_806n;
const TEAM_ROLES = ["maintainer", "member"] as const;
const PROJECT_ROLES = ["read", "write", "admin"] as const;
const TEAM_SLUG = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const ETAGS = {
  team: /^"team-v([1-9]\d*)"$/u,
  member: /^"team-member-v([1-9]\d*)"$/u,
  projectRole: /^"team-project-role-v([1-9]\d*)"$/u
} as const;
const textEncoder = new TextEncoder();

export type TeamRole = (typeof TEAM_ROLES)[number];

export interface Team {
  readonly id: string;
  readonly organizationId: string;
  readonly slug: string;
  readonly displayName: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly version: number;
}

export interface TeamCollection {
  readonly items: readonly Team[];
  readonly nextCursor: string | null;
}

export interface TeamMember {
  readonly teamId: string;
  readonly organizationId: string;
  readonly userId: string;
  readonly role: TeamRole;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly version: number;
}

export interface TeamMemberCollection {
  readonly items: readonly TeamMember[];
  readonly nextCursor: string | null;
}

export interface TeamProjectRole {
  readonly teamId: string;
  readonly organizationId: string;
  readonly projectId: string;
  readonly role: ProjectRole;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly version: number;
}

export interface TeamProjectRoleCollection {
  readonly items: readonly TeamProjectRole[];
  readonly nextCursor: string | null;
}

export interface TeamMutation {
  readonly changed: boolean;
}

export interface TeamResult extends ApiResult<Team> {
  readonly etag: string;
  readonly location?: string;
}

export interface TeamMemberResult extends ApiResult<TeamMember> {
  readonly etag: string;
}

export interface TeamProjectRoleResult extends ApiResult<TeamProjectRole> {
  readonly etag: string;
}

export interface CreateTeamInput {
  readonly organizationId: string;
  readonly slug: string;
  readonly displayName: string;
}

export interface ListTeamsInput {
  readonly organizationId: string;
  readonly pageSize?: number;
  readonly cursor?: string;
}

export interface TeamInput {
  readonly organizationId: string;
  readonly teamId: string;
}

export interface RenameTeamInput extends TeamInput {
  readonly displayName: string;
  readonly etag: string;
}

export interface DeleteTeamInput extends TeamInput {
  readonly etag: string;
}

export interface ListTeamChildrenInput extends TeamInput {
  readonly pageSize?: number;
  readonly cursor?: string;
}

export interface AddTeamMemberInput extends TeamInput {
  readonly userId: string;
  readonly role: TeamRole;
}

export interface ChangeTeamMemberRoleInput extends AddTeamMemberInput {
  readonly etag: string;
}

export interface RemoveTeamMemberInput extends TeamInput {
  readonly userId: string;
  readonly etag: string;
}

export interface AddTeamProjectRoleInput extends TeamInput {
  readonly projectId: string;
  readonly role: ProjectRole;
}

export interface ChangeTeamProjectRoleInput extends AddTeamProjectRoleInput {
  readonly etag: string;
}

export interface RemoveTeamProjectRoleInput extends TeamInput {
  readonly projectId: string;
  readonly etag: string;
}

export async function createTeam(
  client: ApiClient,
  input: CreateTeamInput,
  options: BrowserMutationOptions
): Promise<TeamResult> {
  const organizationId = validateId(input.organizationId);
  const response = await client.post<unknown, unknown>(
    teamCollectionPath(organizationId),
    { slug: validateSlug(input.slug), displayName: validateDisplayName(input.displayName) },
    mutationOptions(options)
  );
  return teamResult(response, 201, organizationId, undefined, true);
}

export async function listTeams(
  client: ApiClient,
  input: ListTeamsInput,
  options: DomainRequestOptions = {}
): Promise<ApiResult<TeamCollection>> {
  const organizationId = validateId(input.organizationId);
  const response = await client.get<unknown>(
    withListQuery(teamCollectionPath(organizationId), input),
    options
  );
  return validatedResult(response, (value) => parseTeamCollection(value, organizationId));
}

export async function getTeam(
  client: ApiClient,
  input: TeamInput,
  options: DomainRequestOptions = {}
): Promise<TeamResult> {
  const organizationId = validateId(input.organizationId);
  const teamId = validateId(input.teamId);
  const response = await client.get<unknown>(teamPath(organizationId, teamId), options);
  return teamResult(response, 200, organizationId, teamId, false);
}

export async function renameTeam(
  client: ApiClient,
  input: RenameTeamInput,
  options: BrowserMutationOptions
): Promise<TeamResult> {
  const organizationId = validateId(input.organizationId);
  const teamId = validateId(input.teamId);
  const response = await client.patch<unknown, unknown>(
    teamPath(organizationId, teamId),
    { displayName: validateDisplayName(input.displayName) },
    mutationOptions(options, { "if-match": validateEtag(input.etag, "team") })
  );
  return teamResult(response, 200, organizationId, teamId, false);
}

export async function deleteTeam(
  client: ApiClient,
  input: DeleteTeamInput,
  options: BrowserMutationOptions
): Promise<ApiResult<TeamMutation>> {
  const response = await client.delete<unknown>(
    teamPath(input.organizationId, input.teamId),
    mutationOptions(options, { "if-match": validateEtag(input.etag, "team") })
  );
  return mutationResult(response);
}

export async function listTeamMembers(
  client: ApiClient,
  input: ListTeamChildrenInput,
  options: DomainRequestOptions = {}
): Promise<ApiResult<TeamMemberCollection>> {
  const context = teamContext(input);
  const response = await client.get<unknown>(
    withListQuery(`${teamPath(context.organizationId, context.teamId)}/members`, input),
    options
  );
  return validatedResult(response, (value) => parseMemberCollection(value, context));
}

export async function addTeamMember(
  client: ApiClient,
  input: AddTeamMemberInput,
  options: BrowserMutationOptions
): Promise<TeamMemberResult> {
  const context = teamContext(input);
  const userId = validateId(input.userId);
  const response = await client.post<unknown, unknown>(
    `${teamPath(context.organizationId, context.teamId)}/members`,
    { userId, role: validateTeamRole(input.role) },
    mutationOptions(options)
  );
  return memberResult(response, 201, { ...context, userId });
}

export async function changeTeamMemberRole(
  client: ApiClient,
  input: ChangeTeamMemberRoleInput,
  options: BrowserMutationOptions
): Promise<TeamMemberResult> {
  const context = { ...teamContext(input), userId: validateId(input.userId) };
  const response = await client.patch<unknown, unknown>(
    memberPath(context),
    { role: validateTeamRole(input.role) },
    mutationOptions(options, { "if-match": validateEtag(input.etag, "member") })
  );
  return memberResult(response, 200, context);
}

export async function removeTeamMember(
  client: ApiClient,
  input: RemoveTeamMemberInput,
  options: BrowserMutationOptions
): Promise<ApiResult<TeamMutation>> {
  const context = { ...teamContext(input), userId: validateId(input.userId) };
  const response = await client.delete<unknown>(
    memberPath(context),
    mutationOptions(options, { "if-match": validateEtag(input.etag, "member") })
  );
  return mutationResult(response);
}

export async function listTeamProjectRoles(
  client: ApiClient,
  input: ListTeamChildrenInput,
  options: DomainRequestOptions = {}
): Promise<ApiResult<TeamProjectRoleCollection>> {
  const context = teamContext(input);
  const response = await client.get<unknown>(
    withListQuery(`${teamPath(context.organizationId, context.teamId)}/project-roles`, input),
    options
  );
  return validatedResult(response, (value) => parseProjectRoleCollection(value, context));
}

export async function addTeamProjectRole(
  client: ApiClient,
  input: AddTeamProjectRoleInput,
  options: BrowserMutationOptions
): Promise<TeamProjectRoleResult> {
  const context = teamContext(input);
  const projectId = validateId(input.projectId);
  const response = await client.post<unknown, unknown>(
    `${teamPath(context.organizationId, context.teamId)}/project-roles`,
    { projectId, role: validateProjectRole(input.role) },
    mutationOptions(options)
  );
  return projectRoleResult(response, 201, { ...context, projectId });
}

export async function changeTeamProjectRole(
  client: ApiClient,
  input: ChangeTeamProjectRoleInput,
  options: BrowserMutationOptions
): Promise<TeamProjectRoleResult> {
  const context = { ...teamContext(input), projectId: validateId(input.projectId) };
  const response = await client.patch<unknown, unknown>(
    projectRolePath(context),
    { role: validateProjectRole(input.role) },
    mutationOptions(options, { "if-match": validateEtag(input.etag, "projectRole") })
  );
  return projectRoleResult(response, 200, context);
}

export async function removeTeamProjectRole(
  client: ApiClient,
  input: RemoveTeamProjectRoleInput,
  options: BrowserMutationOptions
): Promise<ApiResult<TeamMutation>> {
  const context = { ...teamContext(input), projectId: validateId(input.projectId) };
  const response = await client.delete<unknown>(
    projectRolePath(context),
    mutationOptions(options, { "if-match": validateEtag(input.etag, "projectRole") })
  );
  return mutationResult(response);
}

function teamResult(
  response: ApiResponse<unknown>,
  status: 200 | 201,
  organizationId: string,
  expectedTeamId: string | undefined,
  requireLocation: boolean
): TeamResult {
  const parsed = validatedResultForStatus(response, status, (value) =>
    parseTeam(value, organizationId)
  );
  if (expectedTeamId !== undefined && parsed.data.id !== expectedTeamId) {
    throw invalidResponse(response);
  }
  const etag = responseEtag(response, parsed.data.version, "team");
  const location = response.headers.get("location");
  const expectedLocation = `/api/v1${teamPath(organizationId, parsed.data.id)}`;
  if ((requireLocation && location !== expectedLocation) || (!requireLocation && location !== null)) {
    throw invalidResponse(response);
  }
  return { ...parsed, etag, ...(location === null ? {} : { location }) };
}

function memberResult(
  response: ApiResponse<unknown>,
  status: 200 | 201,
  expected: MemberContext
): TeamMemberResult {
  const parsed = validatedResultForStatus(response, status, (value) => parseMember(value, expected));
  if (response.headers.has("location")) throw invalidResponse(response);
  return { ...parsed, etag: responseEtag(response, parsed.data.version, "member") };
}

function projectRoleResult(
  response: ApiResponse<unknown>,
  status: 200 | 201,
  expected: ProjectRoleContext
): TeamProjectRoleResult {
  const parsed = validatedResultForStatus(response, status, (value) =>
    parseProjectRole(value, expected)
  );
  if (response.headers.has("location")) throw invalidResponse(response);
  return { ...parsed, etag: responseEtag(response, parsed.data.version, "projectRole") };
}

function mutationResult(response: ApiResponse<unknown>): ApiResult<TeamMutation> {
  return validatedResult(response, (value) => {
    const record = readExactRecord(value, ["changed"]);
    return { changed: readBoolean(record, "changed") };
  });
}

function parseTeam(value: unknown, organizationId: string): Team {
  const record = readExactRecord(value, [
    "createdAt", "displayName", "id", "organizationId", "slug", "updatedAt", "version"
  ]);
  const result: Team = {
    id: readUuidV7(record, "id"),
    organizationId: readUuidV7(record, "organizationId"),
    slug: readBoundedString(record, "slug", 63),
    displayName: readBoundedString(record, "displayName", 800, { maxCharacters: 200 }),
    createdAt: readUtcTimestamp(record, "createdAt"),
    updatedAt: readUtcTimestamp(record, "updatedAt"),
    version: readPositiveInteger(record, "version")
  };
  if (
    result.organizationId !== organizationId ||
    !TEAM_SLUG.test(result.slug) ||
    !isDisplayName(result.displayName) ||
    Date.parse(result.createdAt) > Date.parse(result.updatedAt)
  ) {
    throw new TypeError("invalid Team");
  }
  return result;
}

function parseTeamCollection(value: unknown, organizationId: string): TeamCollection {
  const record = readExactRecord(value, ["items", "nextCursor"]);
  return {
    items: readBoundedArray(record, "items", MAX_COLLECTION_ITEMS).map((item) =>
      parseTeam(item, organizationId)
    ),
    nextCursor: readNullableCursor(record, "nextCursor")
  };
}

interface TeamContext {
  readonly organizationId: string;
  readonly teamId: string;
}

interface MemberContext extends TeamContext {
  readonly userId: string;
}

interface ProjectRoleContext extends TeamContext {
  readonly projectId: string;
}

function parseMember(value: unknown, expected: TeamContext & { readonly userId?: string }): TeamMember {
  const record = readExactRecord(value, [
    "createdAt", "organizationId", "role", "teamId", "updatedAt", "userId", "version"
  ]);
  const result: TeamMember = {
    teamId: readUuidV7(record, "teamId"),
    organizationId: readUuidV7(record, "organizationId"),
    userId: readUuidV7(record, "userId"),
    role: readEnum(record, "role", TEAM_ROLES),
    createdAt: readUtcTimestamp(record, "createdAt"),
    updatedAt: readUtcTimestamp(record, "updatedAt"),
    version: readPositiveInteger(record, "version")
  };
  if (
    result.organizationId !== expected.organizationId ||
    result.teamId !== expected.teamId ||
    (expected.userId !== undefined && result.userId !== expected.userId) ||
    Date.parse(result.createdAt) > Date.parse(result.updatedAt)
  ) {
    throw new TypeError("invalid Team member");
  }
  return result;
}

function parseMemberCollection(value: unknown, expected: TeamContext): TeamMemberCollection {
  const record = readExactRecord(value, ["items", "nextCursor"]);
  return {
    items: readBoundedArray(record, "items", MAX_COLLECTION_ITEMS).map((item) =>
      parseMember(item, expected)
    ),
    nextCursor: readNullableCursor(record, "nextCursor")
  };
}

function parseProjectRole(value: unknown, expected: TeamContext & { readonly projectId?: string }): TeamProjectRole {
  const record = readExactRecord(value, [
    "createdAt", "organizationId", "projectId", "role", "teamId", "updatedAt", "version"
  ]);
  const result: TeamProjectRole = {
    teamId: readUuidV7(record, "teamId"),
    organizationId: readUuidV7(record, "organizationId"),
    projectId: readUuidV7(record, "projectId"),
    role: readEnum(record, "role", PROJECT_ROLES),
    createdAt: readUtcTimestamp(record, "createdAt"),
    updatedAt: readUtcTimestamp(record, "updatedAt"),
    version: readPositiveInteger(record, "version")
  };
  if (
    result.organizationId !== expected.organizationId ||
    result.teamId !== expected.teamId ||
    (expected.projectId !== undefined && result.projectId !== expected.projectId) ||
    Date.parse(result.createdAt) > Date.parse(result.updatedAt)
  ) {
    throw new TypeError("invalid Team Project role");
  }
  return result;
}

function parseProjectRoleCollection(value: unknown, expected: TeamContext): TeamProjectRoleCollection {
  const record = readExactRecord(value, ["items", "nextCursor"]);
  return {
    items: readBoundedArray(record, "items", MAX_COLLECTION_ITEMS).map((item) =>
      parseProjectRole(item, expected)
    ),
    nextCursor: readNullableCursor(record, "nextCursor")
  };
}

function withListQuery(
  path: `/${string}`,
  input: { readonly pageSize?: number; readonly cursor?: string }
): `/${string}` {
  const pageSize = input.pageSize ?? DEFAULT_PAGE_SIZE;
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_COLLECTION_ITEMS) {
    throw new ApiConfigurationError("The Team page size is invalid.");
  }
  const query = new URLSearchParams({ pageSize: String(pageSize) });
  if (input.cursor !== undefined) query.set("cursor", validateCursor(input.cursor));
  return `${path}?${query.toString()}`;
}

function readNullableCursor(record: Record<string, unknown>, key: string): string | null {
  return record[key] === null
    ? null
    : validateCursor(readBoundedString(record, key, MAX_CURSOR_BYTES));
}

function validateCursor(value: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    textEncoder.encode(value).byteLength > MAX_CURSOR_BYTES ||
    /[\u0000-\u0020\u007f]/u.test(value)
  ) {
    throw new ApiConfigurationError("The Team cursor is invalid.");
  }
  return value;
}

function validateId(value: string): string {
  try {
    return readUuidV7({ value }, "value");
  } catch {
    throw new ApiConfigurationError("The identifier is invalid.");
  }
}

function validateSlug(value: string): string {
  if (typeof value !== "string" || !TEAM_SLUG.test(value)) {
    throw new ApiConfigurationError("The Team slug is invalid.");
  }
  return value;
}

function isDisplayName(value: string): boolean {
  return !value.startsWith(" ") && !value.endsWith(" ") && [...value].length <= 200;
}

function validateDisplayName(value: string): string {
  if (typeof value !== "string" || value.length === 0 || !isDisplayName(value) || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new ApiConfigurationError("The Team display name is invalid.");
  }
  return value;
}

function validateTeamRole(value: TeamRole): TeamRole {
  if (!TEAM_ROLES.includes(value)) throw new ApiConfigurationError("The Team role is invalid.");
  return value;
}

function validateProjectRole(value: ProjectRole): ProjectRole {
  if (!PROJECT_ROLES.includes(value)) {
    throw new ApiConfigurationError("The Team Project role is invalid.");
  }
  return value;
}

type EtagKind = keyof typeof ETAGS;

function validateEtag(value: string, kind: EtagKind): string {
  if (typeof value !== "string" || value.length > 48) {
    throw new ApiConfigurationError("The Team validator is invalid.");
  }
  const match = value.match(ETAGS[kind]);
  if (match === null) throw new ApiConfigurationError("The Team validator is invalid.");
  const version = BigInt(match[1] as string);
  if (version > MAX_VERSION || value !== `"${etagPrefix(kind)}-v${version}"`) {
    throw new ApiConfigurationError("The Team validator is invalid.");
  }
  return value;
}

function responseEtag(response: ApiResponse<unknown>, version: number, kind: EtagKind): string {
  const etag = response.headers.get("etag");
  if (etag?.match(ETAGS[kind])?.[1] !== String(version)) throw invalidResponse(response);
  return etag;
}

function etagPrefix(kind: EtagKind): string {
  if (kind === "member") return "team-member";
  if (kind === "projectRole") return "team-project-role";
  return "team";
}

function teamContext(input: TeamInput): TeamContext {
  return { organizationId: validateId(input.organizationId), teamId: validateId(input.teamId) };
}

function teamCollectionPath(organizationId: string): `/${string}` {
  return `/organizations/${validateId(organizationId)}/teams`;
}

function teamPath(organizationId: string, teamId: string): `/${string}` {
  return `${teamCollectionPath(organizationId)}/${validateId(teamId)}`;
}

function memberPath(context: MemberContext): `/${string}` {
  return `${teamPath(context.organizationId, context.teamId)}/members/${context.userId}`;
}

function projectRolePath(context: ProjectRoleContext): `/${string}` {
  return `${teamPath(context.organizationId, context.teamId)}/project-roles/${context.projectId}`;
}
