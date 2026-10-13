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
import { OneTimeUrl, isTokenForPath } from "./one-time-url.ts";
import type { ApiClient, ApiResponse } from "./types.ts";
import {
  readBoundedArray,
  readBoundedString,
  readEnum,
  readExactRecord,
  readNullableUtcTimestamp,
  readNullableUuidV7,
  readPositiveInteger,
  readUtcTimestamp,
  readUuidV7
} from "./validation.ts";

const MAX_COLLECTION_ITEMS = 100;
const ROLES = ["owner", "member"] as const;
const ORGANIZATION_STATUSES = ["active", "archived"] as const;
const INVITATION_STATUSES = [
  "pending",
  "accepted",
  "declined",
  "expired",
  "revoked",
  "superseded"
] as const;
const STRONG_ETAG = /^"org-v([1-9]\d*)"$/u;

export type OrganizationRole = (typeof ROLES)[number];
export type OrganizationStatus = (typeof ORGANIZATION_STATUSES)[number];
export type OrganizationInvitationStatus = (typeof INVITATION_STATUSES)[number];

export interface Organization {
  readonly id: string;
  readonly slug: string;
  readonly displayName: string;
  readonly status: OrganizationStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archivedAt: string | null;
  readonly version: number;
}

export interface OrganizationResult extends ApiResult<Organization> {
  readonly etag: string;
  readonly location?: string;
}

export interface OrganizationMember {
  readonly userId: string;
  readonly displayName: string;
  readonly role: OrganizationRole;
}

export interface OrganizationMemberCollection {
  readonly items: readonly OrganizationMember[];
}

export interface OrganizationInvitation {
  readonly id: string;
  readonly organizationId: string;
  readonly inviteeUserId: string;
  readonly proposedRole: OrganizationRole;
  readonly status: OrganizationInvitationStatus;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly acceptedAt: string | null;
  readonly declinedAt: string | null;
  readonly expiredAt: string | null;
  readonly revokedAt: string | null;
  readonly supersededAt: string | null;
  readonly replacementId: string | null;
}

export interface OrganizationInvitationCollection {
  readonly items: readonly OrganizationInvitation[];
}

export type IssuedOrganizationInvitation = OrganizationInvitation & (
  | { readonly delivery: "copy_once"; readonly acceptUrl: OneTimeUrl }
  | { readonly delivery: "email_queued"; readonly acceptUrl: null }
);

export interface CreateOrganizationInput {
  readonly slug: string;
  readonly displayName: string;
}

export interface UpdateOrganizationInput {
  readonly organizationId: string;
  readonly displayName: string;
  readonly etag: string;
}

export interface ArchiveOrganizationInput {
  readonly organizationId: string;
  readonly etag: string;
}

export interface OrganizationMemberInput {
  readonly organizationId: string;
  readonly userId: string;
}

export interface ChangeOrganizationMemberRoleInput extends OrganizationMemberInput {
  readonly role: OrganizationRole;
}

export interface IssueOrganizationInvitationInput {
  readonly organizationId: string;
  readonly email: string;
  readonly role: OrganizationRole;
}

export interface ReissueOrganizationInvitationInput {
  readonly organizationId: string;
  readonly invitationId: string;
  readonly role: OrganizationRole;
}

export interface OrganizationInvitationInput {
  readonly organizationId: string;
  readonly invitationId: string;
}

export async function createOrganization(
  client: ApiClient,
  input: CreateOrganizationInput,
  options: BrowserMutationOptions
): Promise<OrganizationResult> {
  const response = await client.post<unknown, unknown>(
    "/organizations",
    { slug: input.slug, displayName: input.displayName },
    mutationOptions(options)
  );
  return organizationResult(response, 201, true);
}

export async function getOrganization(
  client: ApiClient,
  organizationId: string,
  options: DomainRequestOptions = {}
): Promise<OrganizationResult> {
  const response = await client.get<unknown>(organizationPath(organizationId), options);
  return organizationResult(response, 200, false);
}

export async function updateOrganization(
  client: ApiClient,
  input: UpdateOrganizationInput,
  options: BrowserMutationOptions
): Promise<OrganizationResult> {
  const response = await client.patch<unknown, unknown>(
    organizationPath(input.organizationId),
    { displayName: input.displayName },
    mutationOptions(options, { "if-match": validateEtag(input.etag) })
  );
  return organizationResult(response, 200, false);
}

export async function archiveOrganization(
  client: ApiClient,
  input: ArchiveOrganizationInput,
  options: BrowserMutationOptions
): Promise<OrganizationResult> {
  const response = await client.post<unknown, undefined>(
    `${organizationPath(input.organizationId)}/archive`,
    undefined,
    mutationOptions(options, { "if-match": validateEtag(input.etag) })
  );
  return organizationResult(response, 200, false);
}

export async function listOrganizationMembers(
  client: ApiClient,
  organizationId: string,
  options: DomainRequestOptions = {}
): Promise<ApiResult<OrganizationMemberCollection>> {
  const response = await client.get<unknown>(`${organizationPath(organizationId)}/members`, options);
  return validatedResult(response, parseMemberCollection);
}

export async function changeOrganizationMemberRole(
  client: ApiClient,
  input: ChangeOrganizationMemberRoleInput,
  options: BrowserMutationOptions
): Promise<ApiEmptyResult> {
  const response = await client.patch<unknown, unknown>(
    memberPath(input),
    { role: validateRole(input.role) },
    mutationOptions(options)
  );
  return requireNoContent(response);
}

export async function removeOrganizationMember(
  client: ApiClient,
  input: OrganizationMemberInput,
  options: BrowserMutationOptions
): Promise<ApiEmptyResult> {
  const response = await client.delete<unknown>(memberPath(input), mutationOptions(options));
  return requireNoContent(response);
}

export async function listOrganizationInvitations(
  client: ApiClient,
  organizationId: string,
  options: DomainRequestOptions = {}
): Promise<ApiResult<OrganizationInvitationCollection>> {
  const response = await client.get<unknown>(
    `${organizationPath(organizationId)}/invitations`,
    options
  );
  return validatedResult(response, parseInvitationCollection);
}

export async function issueOrganizationInvitation(
  client: ApiClient,
  input: IssueOrganizationInvitationInput,
  options: BrowserMutationOptions
): Promise<ApiResult<IssuedOrganizationInvitation>> {
  rejectLegacyInvitationInput(input);
  const organizationId = validatedId(input.organizationId);
  const role = validateRole(input.role);
  const response = await client.post<unknown, unknown>(
    `/organizations/${organizationId}/invitations`,
    { email: normalizeInvitationEmail(input.email), role },
    mutationOptions(options)
  );
  return issuedInvitationResult(response, 201, { organizationId, role });
}

export async function reissueOrganizationInvitation(
  client: ApiClient,
  input: ReissueOrganizationInvitationInput,
  options: BrowserMutationOptions
): Promise<ApiResult<IssuedOrganizationInvitation>> {
  const organizationId = validatedId(input.organizationId);
  const invitationId = validatedId(input.invitationId);
  const role = validateRole(input.role);
  const response = await client.post<unknown, unknown>(
    `/organizations/${organizationId}/invitations/${invitationId}/reissue`,
    { role },
    mutationOptions(options)
  );
  return issuedInvitationResult(response, 200, {
    organizationId,
    role,
    replacesInvitationId: invitationId
  });
}

export async function revokeOrganizationInvitation(
  client: ApiClient,
  input: OrganizationInvitationInput,
  options: BrowserMutationOptions
): Promise<ApiEmptyResult> {
  const response = await client.delete<unknown>(invitationPath(input), mutationOptions(options));
  return requireNoContent(response);
}

export function acceptOrganizationInvitation(
  client: ApiClient,
  token: string,
  options: BrowserMutationOptions
): Promise<ApiResult<OrganizationInvitation>> {
  return respondToInvitation(client, "accept", token, options);
}

export function declineOrganizationInvitation(
  client: ApiClient,
  token: string,
  options: BrowserMutationOptions
): Promise<ApiResult<OrganizationInvitation>> {
  return respondToInvitation(client, "decline", token, options);
}

async function respondToInvitation(
  client: ApiClient,
  action: "accept" | "decline",
  token: string,
  options: BrowserMutationOptions
): Promise<ApiResult<OrganizationInvitation>> {
  validateToken(token);
  const response = await client.post<unknown, unknown>(
    `/me/organization-invitations/${action}`,
    { token },
    mutationOptions(options)
  );
  const expectedStatus = action === "accept" ? "accepted" : "declined";
  return validatedResult(response, (value) => {
    const invitation = parseInvitation(value);
    if (invitation.status !== expectedStatus) {
      throw invalidResponse(response);
    }
    return invitation;
  });
}

function organizationResult(
  response: ApiResponse<unknown>,
  status: 200 | 201,
  requireLocation: boolean
): OrganizationResult {
  const parsed = validatedResultForStatus(response, status, parseOrganization);
  const etag = validateResponseEtag(response.headers.get("etag"), parsed.data.version, response);
  const location = response.headers.get("location");
  const expectedLocation = `/api/v1/organizations/${parsed.data.id}`;
  if ((requireLocation && location !== expectedLocation) || (!requireLocation && location !== null)) {
    throw invalidResponse(response);
  }
  return {
    ...parsed,
    etag,
    ...(location === null ? {} : { location })
  };
}

function parseOrganization(value: unknown): Organization {
  const record = readExactRecord(value, [
    "archivedAt",
    "createdAt",
    "displayName",
    "id",
    "slug",
    "status",
    "updatedAt",
    "version"
  ]);
  const result: Organization = {
    id: readUuidV7(record, "id"),
    slug: readBoundedString(record, "slug", 63),
    displayName: readBoundedString(record, "displayName", 800, { maxCharacters: 200 }),
    status: readEnum(record, "status", ORGANIZATION_STATUSES),
    createdAt: readUtcTimestamp(record, "createdAt"),
    updatedAt: readUtcTimestamp(record, "updatedAt"),
    archivedAt: readNullableUtcTimestamp(record, "archivedAt"),
    version: readPositiveInteger(record, "version")
  };
  if (
    !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(result.slug) ||
    Date.parse(result.createdAt) > Date.parse(result.updatedAt) ||
    (result.status === "active" && result.archivedAt !== null) ||
    (result.status === "archived" && result.archivedAt === null)
  ) {
    throw new TypeError("invalid Organization lifecycle");
  }
  return result;
}

function parseMemberCollection(value: unknown): OrganizationMemberCollection {
  const root = readExactRecord(value, ["items"]);
  return {
    items: readBoundedArray(root, "items", MAX_COLLECTION_ITEMS).map((item) => {
      const record = readExactRecord(item, ["displayName", "role", "userId"]);
      return {
        userId: readUuidV7(record, "userId"),
        displayName: readBoundedString(record, "displayName", 800, { maxCharacters: 200 }),
        role: readEnum(record, "role", ROLES)
      };
    })
  };
}

function parseInvitationCollection(value: unknown): OrganizationInvitationCollection {
  const root = readExactRecord(value, ["items"]);
  return {
    items: readBoundedArray(root, "items", MAX_COLLECTION_ITEMS).map(parseInvitation)
  };
}

function issuedInvitationResult(
  response: ApiResponse<unknown>,
  status: 200 | 201,
  expected: {
    readonly organizationId: string;
    readonly replacesInvitationId?: string;
    readonly role: OrganizationRole;
  }
): ApiResult<IssuedOrganizationInvitation> {
  return validatedResultForStatus(response, status, (value) => {
    const record = invitationRecord(value, ["acceptUrl", "delivery"]);
    const invitation = parseInvitationRecord(record);
    if (
      invitation.organizationId !== expected.organizationId ||
      invitation.proposedRole !== expected.role ||
      invitation.status !== "pending" ||
      (expected.replacesInvitationId !== undefined &&
        invitation.id === expected.replacesInvitationId)
    ) {
      throw new TypeError("invalid issued invitation identity");
    }
    const delivery = readEnum(record, "delivery", ["copy_once", "email_queued"] as const);
    if (delivery === "email_queued") {
      if (record.acceptUrl !== null) throw invalidResponse(response);
      return { ...invitation, delivery, acceptUrl: null };
    }
    return {
      ...invitation,
      delivery,
      acceptUrl: OneTimeUrl.parse(
        record.acceptUrl,
        "/organization-invitations/accept",
        response.status,
        response.requestId
      )
    };
  });
}

function parseInvitation(value: unknown): OrganizationInvitation {
  return parseInvitationRecord(invitationRecord(value));
}

const INVITATION_KEYS = [
  "acceptedAt",
  "createdAt",
  "declinedAt",
  "expiredAt",
  "expiresAt",
  "id",
  "inviteeUserId",
  "organizationId",
  "proposedRole",
  "replacementId",
  "revokedAt",
  "status",
  "supersededAt"
] as const;

function invitationRecord(value: unknown, extra: readonly string[] = []): Record<string, unknown> {
  return readExactRecord(value, [...INVITATION_KEYS, ...extra]);
}

function parseInvitationRecord(record: Record<string, unknown>): OrganizationInvitation {
  const result: OrganizationInvitation = {
    id: readUuidV7(record, "id"),
    organizationId: readUuidV7(record, "organizationId"),
    inviteeUserId: readUuidV7(record, "inviteeUserId"),
    proposedRole: readEnum(record, "proposedRole", ROLES),
    status: readEnum(record, "status", INVITATION_STATUSES),
    createdAt: readUtcTimestamp(record, "createdAt"),
    expiresAt: readUtcTimestamp(record, "expiresAt"),
    acceptedAt: readNullableUtcTimestamp(record, "acceptedAt"),
    declinedAt: readNullableUtcTimestamp(record, "declinedAt"),
    expiredAt: readNullableUtcTimestamp(record, "expiredAt"),
    revokedAt: readNullableUtcTimestamp(record, "revokedAt"),
    supersededAt: readNullableUtcTimestamp(record, "supersededAt"),
    replacementId: readNullableUuidV7(record, "replacementId")
  };
  validateInvitationLifecycle(result);
  return result;
}

function validateInvitationLifecycle(value: OrganizationInvitation): void {
  if (Date.parse(value.createdAt) >= Date.parse(value.expiresAt)) {
    throw new TypeError("invalid invitation time order");
  }
  const terminalByStatus = {
    accepted: value.acceptedAt,
    declined: value.declinedAt,
    expired: value.expiredAt,
    revoked: value.revokedAt,
    superseded: value.supersededAt
  } as const;
  const terminals = Object.values(terminalByStatus).filter((item) => item !== null).length;
  const valid = value.status === "pending"
    ? terminals === 0 && value.replacementId === null
    : terminalByStatus[value.status] !== null &&
      terminals === 1 &&
      (value.status === "superseded") === (value.replacementId !== null);
  if (!valid) {
    throw new TypeError("invalid invitation lifecycle");
  }
}

function validateResponseEtag(
  value: string | null,
  version: number,
  response: ApiResponse<unknown>
): string {
  const match = value?.match(STRONG_ETAG);
  if (match?.[1] !== String(version)) {
    throw invalidResponse(response);
  }
  return value as string;
}

function validateEtag(value: string): string {
  if (!STRONG_ETAG.test(value)) {
    throw new ApiConfigurationError("The Organization validator is invalid.");
  }
  return value;
}

function validateRole(value: OrganizationRole): OrganizationRole {
  if (!ROLES.includes(value)) {
    throw new ApiConfigurationError("The Organization role is invalid.");
  }
  return value;
}

function rejectLegacyInvitationInput(input: IssueOrganizationInvitationInput): void {
  if ("inviteeUserId" in input) {
    throw new ApiConfigurationError("The invitation input is invalid.");
  }
}

function normalizeInvitationEmail(value: string): string {
  if (typeof value !== "string" || value.startsWith(" ") || value.endsWith(" ")) {
    throw new ApiConfigurationError("The invitation email is invalid.");
  }
  let characters = 0;
  for (const character of value) {
    characters += 1;
    const codePoint = character.codePointAt(0);
    if (
      characters > 320 ||
      /\p{Cc}/u.test(character) ||
      (codePoint !== undefined && codePoint >= 0xd800 && codePoint <= 0xdfff)
    ) {
      throw new ApiConfigurationError("The invitation email is invalid.");
    }
  }
  if (characters < 3) {
    throw new ApiConfigurationError("The invitation email is invalid.");
  }
  return value.toLowerCase();
}

function validateToken(value: string): void {
  if (!isTokenForPath(value, "/organization-invitations/accept")) {
    throw new ApiConfigurationError("The invitation credential is invalid.");
  }
}

function validatedId(value: string): string {
  try {
    return readUuidV7({ value }, "value");
  } catch {
    throw new ApiConfigurationError("The identifier is invalid.");
  }
}

function organizationPath(organizationId: string): `/${string}` {
  return `/organizations/${validatedId(organizationId)}`;
}

function memberPath(input: OrganizationMemberInput): `/${string}` {
  return `${organizationPath(input.organizationId)}/members/${validatedId(input.userId)}`;
}

function invitationPath(input: OrganizationInvitationInput): `/${string}` {
  return `${organizationPath(input.organizationId)}/invitations/${validatedId(input.invitationId)}`;
}
