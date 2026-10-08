import { mutationOptions } from "./browser-mutation.ts";
import type { BrowserMutationOptions } from "./browser-mutation.ts";
import { requireNoContent, validatedResult, validatedResultForStatus } from "./domain.ts";
import type { ApiEmptyResult, ApiResult, DomainRequestOptions } from "./domain.ts";
import type { ApiClient } from "./types.ts";
import {
  readBoundedArray,
  readBoundedString,
  readEnum,
  readExactRecord,
  readPositiveInteger,
  readNullableUtcTimestamp,
  readUtcTimestamp,
  readUuidV7
} from "./validation.ts";

const PROVIDER_STATES = ["active", "disabled"] as const;

export type OidcProviderState = (typeof PROVIDER_STATES)[number];

export interface OidcLoginProvider {
  readonly id: string;
  readonly displayName: string;
}

export interface OidcIdentity {
  readonly providerId: string;
  readonly providerDisplayName: string;
  readonly linkedAt: string;
  readonly lastAuthenticatedAt: string | null;
}

export interface OidcProvider {
  readonly id: string;
  readonly displayName: string;
  readonly issuer: string;
  readonly clientId: string;
  readonly state: OidcProviderState;
  readonly configVersion: number;
  readonly secretVersion: number;
  readonly linkedIdentityCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateOidcProviderInput {
  readonly displayName: string;
  readonly issuer: string;
  readonly clientId: string;
  readonly clientSecret: string;
}

export interface UpdateOidcProviderInput {
  readonly displayName: string;
  readonly clientId: string;
}

export async function listOidcLoginProviders(
  client: ApiClient,
  options: DomainRequestOptions = {}
): Promise<ApiResult<readonly OidcLoginProvider[]>> {
  return validatedResult(await client.get<unknown>("/auth/oidc/providers", options), parseLoginProviders);
}

export async function listOidcIdentities(
  client: ApiClient,
  options: DomainRequestOptions = {}
): Promise<ApiResult<readonly OidcIdentity[]>> {
  return validatedResult(await client.get<unknown>("/me/oidc-identities", options), parseIdentities);
}

export async function unlinkOidcIdentity(
  client: ApiClient,
  providerId: string,
  options: BrowserMutationOptions
): Promise<ApiEmptyResult> {
  const id = readUuidV7({ id: providerId }, "id");
  return requireNoContent(await client.delete<unknown>(`/me/oidc-identities/${id}`, mutationOptions(options)));
}

export async function listAdminOidcProviders(
  client: ApiClient,
  options: DomainRequestOptions = {}
): Promise<ApiResult<readonly OidcProvider[]>> {
  return validatedResult(await client.get<unknown>("/admin/oidc/providers", options), parseProviders);
}

export async function createOidcProvider(
  client: ApiClient,
  input: CreateOidcProviderInput,
  options: BrowserMutationOptions
): Promise<ApiResult<OidcProvider>> {
  return validatedResultForStatus(
    await client.post<unknown, CreateOidcProviderInput>("/admin/oidc/providers", input, mutationOptions(options)),
    201,
    parseProvider
  );
}

export function updateOidcProvider(
  client: ApiClient,
  providerId: string,
  version: number,
  input: UpdateOidcProviderInput,
  options: BrowserMutationOptions
): Promise<ApiResult<OidcProvider>> {
  return providerMutation(client, "PATCH", providerId, version, input, options);
}

export function disableOidcProvider(
  client: ApiClient,
  providerId: string,
  version: number,
  options: BrowserMutationOptions
): Promise<ApiResult<OidcProvider>> {
  return providerMutation(client, "POST", providerId, version, undefined, options, "/disable");
}

export function rotateOidcProviderSecret(
  client: ApiClient,
  providerId: string,
  version: number,
  clientSecret: string,
  options: BrowserMutationOptions
): Promise<ApiResult<OidcProvider>> {
  return providerMutation(client, "POST", providerId, version, { clientSecret }, options, "/rotate-secret");
}

export function activateOidcProvider(
  client: ApiClient,
  providerId: string,
  version: number,
  redirectUri: string,
  options: BrowserMutationOptions
): Promise<ApiResult<OidcProvider>> {
  return providerMutation(client, "POST", providerId, version, { redirectUri }, options, "/activate");
}

export async function deleteOidcProvider(
  client: ApiClient,
  providerId: string,
  version: number,
  options: BrowserMutationOptions
): Promise<ApiEmptyResult> {
  const id = readUuidV7({ id: providerId }, "id");
  return requireNoContent(await client.delete<unknown>(`/admin/oidc/providers/${id}`, mutationOptions(options, etag(version))));
}

async function providerMutation(
  client: ApiClient,
  method: "PATCH" | "POST",
  providerId: string,
  version: number,
  body: unknown,
  options: BrowserMutationOptions,
  suffix = ""
): Promise<ApiResult<OidcProvider>> {
  const id = readUuidV7({ id: providerId }, "id");
  const path = `/admin/oidc/providers/${id}${suffix}` as `/${string}`;
  const requestOptions = mutationOptions(options, etag(version));
  const response = method === "PATCH"
    ? await client.patch<unknown, unknown>(path, body, requestOptions)
    : await client.post<unknown, unknown>(path, body, requestOptions);
  return validatedResult(response, parseProvider);
}

function etag(version: number): Headers {
  if (!Number.isSafeInteger(version) || version < 1) throw new TypeError("invalid OIDC Provider version");
  return new Headers({ "if-match": `"oidc-provider-v${version}"` });
}

function parseLoginProviders(value: unknown): readonly OidcLoginProvider[] {
  const record = readExactRecord(value, ["items"]);
  return readBoundedArray(record, "items", 100).map((item) => {
    const provider = readExactRecord(item, ["displayName", "id"]);
    return { id: readUuidV7(provider, "id"), displayName: readBoundedString(provider, "displayName", 800, { maxCharacters: 200 }) };
  });
}

function parseIdentities(value: unknown): readonly OidcIdentity[] {
  const record = readExactRecord(value, ["items"]);
  return readBoundedArray(record, "items", 100).map((item) => {
    const identity = readExactRecord(item, ["lastAuthenticatedAt", "linkedAt", "providerDisplayName", "providerId"]);
    return {
      providerId: readUuidV7(identity, "providerId"),
      providerDisplayName: readBoundedString(identity, "providerDisplayName", 800, { maxCharacters: 200 }),
      linkedAt: readUtcTimestamp(identity, "linkedAt"),
      lastAuthenticatedAt: readNullableUtcTimestamp(identity, "lastAuthenticatedAt")
    };
  });
}

function parseProviders(value: unknown): readonly OidcProvider[] {
  const record = readExactRecord(value, ["items"]);
  return readBoundedArray(record, "items", 100).map(parseProvider);
}

function parseProvider(value: unknown): OidcProvider {
  const record = readExactRecord(value, [
    "clientId", "configVersion", "createdAt", "displayName", "id", "issuer",
    "linkedIdentityCount", "secretVersion", "state", "updatedAt"
  ]);
  return {
    id: readUuidV7(record, "id"),
    displayName: readBoundedString(record, "displayName", 800, { maxCharacters: 200 }),
    issuer: readBoundedString(record, "issuer", 2_048),
    clientId: readBoundedString(record, "clientId", 1_024),
    state: readEnum(record, "state", PROVIDER_STATES),
    configVersion: readPositiveInteger(record, "configVersion"),
    secretVersion: readPositiveInteger(record, "secretVersion"),
    linkedIdentityCount: readNonNegativeInteger(record, "linkedIdentityCount"),
    createdAt: readUtcTimestamp(record, "createdAt"),
    updatedAt: readUtcTimestamp(record, "updatedAt")
  };
}

function readNonNegativeInteger(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new TypeError("invalid integer");
  return value as number;
}
