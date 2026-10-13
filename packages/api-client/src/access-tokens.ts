import { mutationOptions } from "./browser-mutation.ts";
import type { BrowserMutationOptions } from "./browser-mutation.ts";
import {
  type ApiResult,
  type DomainRequestOptions,
  validatedResult,
  validatedResultForStatus
} from "./domain.ts";
import type { ApiClient } from "./types.ts";
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

const KINDS = ["personal", "project"] as const;
const STATUSES = ["active", "revoked", "expired"] as const;
const SCOPES = [
  "project:read",
  "project:write",
  "project:publish",
  "project:manage",
  "git:read",
  "git:write"
] as const;

export type AccessTokenKind = (typeof KINDS)[number];
export type AccessTokenStatus = (typeof STATUSES)[number];
export type AccessTokenScope = (typeof SCOPES)[number];

export type AccessTokenTarget =
  | { readonly kind: "personal" }
  | { readonly kind: "project"; readonly projectId: string };

export interface AccessToken {
  readonly id: string;
  readonly kind: AccessTokenKind;
  readonly name: string;
  readonly projectId: string | null;
  readonly scopes: readonly AccessTokenScope[];
  readonly status: AccessTokenStatus;
  readonly prefix: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly revokedAt: string | null;
  readonly lastUsedAt: string | null;
  readonly lastApiCategory: string | null;
  readonly recentSourceIps: readonly string[];
}

export interface IssuedAccessToken {
  readonly token: AccessToken;
  readonly plaintext: string;
}

export interface IssueAccessTokenInput {
  readonly name: string;
  readonly scopes: readonly AccessTokenScope[];
  readonly expiryDays?: number;
}

export function listAccessTokens(
  client: ApiClient,
  target: AccessTokenTarget,
  options: DomainRequestOptions = {}
): Promise<ApiResult<readonly AccessToken[]>> {
  return validatedList(client, targetPath(target), options);
}

export async function issueAccessToken(
  client: ApiClient,
  target: AccessTokenTarget,
  input: IssueAccessTokenInput,
  options: BrowserMutationOptions
): Promise<ApiResult<IssuedAccessToken>> {
  const response = await client.post<unknown, IssueAccessTokenInput>(
    targetPath(target),
    input,
    mutationOptions(options)
  );
  return validatedResultForStatus(response, 201, parseIssuedAccessToken);
}

export async function revokeAccessToken(
  client: ApiClient,
  target: AccessTokenTarget,
  tokenId: string,
  options: BrowserMutationOptions
): Promise<ApiResult<AccessToken>> {
  const id = readUuidV7({ id: tokenId }, "id");
  return validatedResult(
    await client.delete<unknown>(`${targetPath(target)}/${id}`, mutationOptions(options)),
    parseAccessToken
  );
}

export async function rotateAccessToken(
  client: ApiClient,
  target: AccessTokenTarget,
  tokenId: string,
  expiryDays: number | undefined,
  options: BrowserMutationOptions
): Promise<ApiResult<IssuedAccessToken>> {
  const id = readUuidV7({ id: tokenId }, "id");
  const response = await client.post<unknown, { readonly expiryDays?: number }>(
    `${targetPath(target)}/${id}/rotate`,
    expiryDays === undefined ? {} : { expiryDays },
    mutationOptions(options)
  );
  return validatedResultForStatus(response, 201, parseIssuedAccessToken);
}

function targetPath(target: AccessTokenTarget): `/${string}` {
  if (target.kind === "personal") return "/access-tokens";
  const projectId = readUuidV7({ id: target.projectId }, "id");
  return `/projects/${projectId}/access-tokens`;
}

async function validatedList(
  client: ApiClient,
  path: `/${string}`,
  options: DomainRequestOptions
): Promise<ApiResult<readonly AccessToken[]>> {
  return validatedResult(await client.get<unknown>(path, options), (value) => {
    if (!Array.isArray(value) || value.length > 200) throw new TypeError("invalid access token list");
    return value.map(parseAccessToken);
  });
}

function parseIssuedAccessToken(value: unknown): IssuedAccessToken {
  const record = readExactRecord(value, ["plaintext", "token"]);
  return {
    token: parseAccessToken(record.token),
    plaintext: readBoundedString(record, "plaintext", 128)
  };
}

function parseAccessToken(value: unknown): AccessToken {
  const record = readExactRecord(value, [
    "createdAt", "expiresAt", "id", "kind", "lastApiCategory", "lastUsedAt", "name",
    "prefix", "projectId", "recentSourceIps", "revokedAt", "scopes", "status"
  ]);
  const kind = readEnum(record, "kind", KINDS);
  const projectId = readNullableUuidV7(record, "projectId");
  if ((kind === "personal") !== (projectId === null)) throw new TypeError("invalid token owner");
  return {
    id: readUuidV7(record, "id"),
    kind,
    name: readBoundedString(record, "name", 480, { maxCharacters: 120 }),
    projectId,
    scopes: readBoundedArray(record, "scopes", SCOPES.length).map((scope) =>
      readEnum({ scope }, "scope", SCOPES)
    ),
    status: readEnum(record, "status", STATUSES),
    prefix: readBoundedString(record, "prefix", 64),
    createdAt: readUtcTimestamp(record, "createdAt"),
    expiresAt: readUtcTimestamp(record, "expiresAt"),
    revokedAt: readNullableUtcTimestamp(record, "revokedAt"),
    lastUsedAt: readNullableUtcTimestamp(record, "lastUsedAt"),
    lastApiCategory: nullableString(record, "lastApiCategory", 64),
    recentSourceIps: readBoundedArray(record, "recentSourceIps", 5).map((ip) =>
      readBoundedString({ ip }, "ip", 45)
    )
  };
}

function nullableString(record: Record<string, unknown>, key: string, maxBytes: number): string | null {
  return record[key] === null ? null : readBoundedString(record, key, maxBytes);
}
