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
import { OneTimeUrl, isTokenForPath } from "./one-time-url.ts";
import { ApiConfigurationError } from "./errors.ts";
import type { ApiClient, ApiResponse } from "./types.ts";
import {
  readBoundedArray,
  readBoundedString,
  readEnum,
  readExactRecord,
  readNullableUtcTimestamp,
  readNullableUuidV7,
  readUtcTimestamp,
  readUuidV7
} from "./validation.ts";

const MAX_INVITATIONS = 100;
const ACTIVATION_STATUSES = [
  "pending",
  "accepted",
  "expired",
  "revoked",
  "superseded"
] as const;

export type ActivationInvitationStatus = (typeof ACTIVATION_STATUSES)[number];

export interface ActivationInvitation {
  readonly id: string;
  readonly email: string;
  readonly status: ActivationInvitationStatus;
  readonly created_at: string;
  readonly expires_at: string;
  readonly accepted_at: string | null;
  readonly revoked_at: string | null;
  readonly superseded_at: string | null;
  readonly replacement_id: string | null;
}

export interface ActivationInvitationCollection {
  readonly items: readonly ActivationInvitation[];
}

export type IssuedActivationInvitation = ActivationInvitation & (
  | { readonly delivery: "copy_once"; readonly activationUrl: OneTimeUrl }
  | { readonly delivery: "email_queued"; readonly activationUrl: null }
);

export interface IssueActivationInvitationInput {
  readonly email: string;
  readonly expiresInSeconds?: number;
}

export interface ReissueActivationInvitationInput {
  readonly invitationId: string;
  readonly expiresInSeconds?: number;
}

export interface ActivateAccountInput {
  readonly token: string;
  readonly email: string;
  readonly displayName: string;
  readonly password: string;
}

export async function issueActivationInvitation(
  client: ApiClient,
  input: IssueActivationInvitationInput,
  options: BrowserMutationOptions
): Promise<ApiResult<IssuedActivationInvitation>> {
  const response = await client.post<unknown, unknown>(
    "/admin/activation-invitations",
    expiryBody({ email: input.email }, input.expiresInSeconds),
    mutationOptions(options)
  );
  return issuedResult(response, 201);
}

export async function listActivationInvitations(
  client: ApiClient,
  options: DomainRequestOptions = {}
): Promise<ApiResult<ActivationInvitationCollection>> {
  const response = await client.get<unknown>("/admin/activation-invitations", options);
  return validatedResult(response, parseCollection);
}

export async function reissueActivationInvitation(
  client: ApiClient,
  input: ReissueActivationInvitationInput,
  options: BrowserMutationOptions
): Promise<ApiResult<IssuedActivationInvitation>> {
  const id = validatedId(input.invitationId);
  const response = await client.post<unknown, unknown>(
    `/admin/activation-invitations/${id}/reissue`,
    expiryBody({}, input.expiresInSeconds),
    mutationOptions(options)
  );
  return issuedResult(response, 200);
}

export async function revokeActivationInvitation(
  client: ApiClient,
  invitationId: string,
  options: BrowserMutationOptions
): Promise<ApiEmptyResult> {
  const response = await client.delete<unknown>(
    `/admin/activation-invitations/${validatedId(invitationId)}`,
    mutationOptions(options)
  );
  return requireNoContent(response);
}

export async function activateAccount(
  client: ApiClient,
  input: ActivateAccountInput,
  options: DomainRequestOptions = {}
): Promise<ApiEmptyResult> {
  if (!isTokenForPath(input.token, "/activate")) {
    throw new ApiConfigurationError("The activation credential is invalid.");
  }
  const response = await client.post<unknown, unknown>(
    "/auth/activation",
    {
      token: input.token,
      email: input.email,
      display_name: input.displayName,
      password: input.password
    },
    options
  );
  return requireNoContent(response);
}

function issuedResult(
  response: ApiResponse<unknown>,
  status: 200 | 201
): ApiResult<IssuedActivationInvitation> {
  return validatedResultForStatus(response, status, (value) => {
    const record = readExactRecord(value, [
      "accepted_at",
      "activation_url",
      "created_at",
      "delivery",
      "email",
      "expires_at",
      "id",
      "replacement_id",
      "revoked_at",
      "status",
      "superseded_at"
    ]);
    const invitation = parseInvitationRecord(record);
    const delivery = readEnum(record, "delivery", ["copy_once", "email_queued"] as const);
    if (delivery === "email_queued") {
      if (record.activation_url !== null) throw invalidResponse(response);
      return { ...invitation, delivery, activationUrl: null };
    }
    return {
      ...invitation,
      delivery,
      activationUrl: OneTimeUrl.parse(
        record.activation_url,
        "/activate",
        response.status,
        response.requestId
      )
    };
  });
}

function parseCollection(value: unknown): ActivationInvitationCollection {
  const root = readExactRecord(value, ["items"]);
  return {
    items: readBoundedArray(root, "items", MAX_INVITATIONS).map(parseInvitation)
  };
}

function parseInvitation(value: unknown): ActivationInvitation {
  return parseInvitationRecord(
    readExactRecord(value, [
      "accepted_at",
      "created_at",
      "email",
      "expires_at",
      "id",
      "replacement_id",
      "revoked_at",
      "status",
      "superseded_at"
    ])
  );
}

function parseInvitationRecord(record: Record<string, unknown>): ActivationInvitation {
  const result: ActivationInvitation = {
    id: readUuidV7(record, "id"),
    email: readBoundedString(record, "email", 320),
    status: readEnum(record, "status", ACTIVATION_STATUSES),
    created_at: readUtcTimestamp(record, "created_at"),
    expires_at: readUtcTimestamp(record, "expires_at"),
    accepted_at: readNullableUtcTimestamp(record, "accepted_at"),
    revoked_at: readNullableUtcTimestamp(record, "revoked_at"),
    superseded_at: readNullableUtcTimestamp(record, "superseded_at"),
    replacement_id: readNullableUuidV7(record, "replacement_id")
  };
  validateActivationLifecycle(result);
  return result;
}

function validateActivationLifecycle(value: ActivationInvitation): void {
  if (Date.parse(value.created_at) >= Date.parse(value.expires_at)) {
    throw new TypeError("invalid invitation time order");
  }
  const terminals = [value.accepted_at, value.revoked_at, value.superseded_at].filter(
    (item) => item !== null
  ).length;
  const valid =
    (value.status === "pending" && terminals === 0 && value.replacement_id === null) ||
    (value.status === "expired" && terminals === 0 && value.replacement_id === null) ||
    (value.status === "accepted" && value.accepted_at !== null && terminals === 1 && value.replacement_id === null) ||
    (value.status === "revoked" && value.revoked_at !== null && terminals === 1 && value.replacement_id === null) ||
    (value.status === "superseded" && value.superseded_at !== null && terminals === 1 && value.replacement_id !== null);
  if (!valid) {
    throw new TypeError("invalid invitation lifecycle");
  }
}

function expiryBody(
  base: Record<string, unknown>,
  expiresInSeconds: number | undefined
): Record<string, unknown> {
  return expiresInSeconds === undefined
    ? base
    : { ...base, expires_in_seconds: expiresInSeconds };
}

function validatedId(value: string): string {
  return readUuidV7({ value }, "value");
}
