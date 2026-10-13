import { mutationOptions } from "./browser-mutation.ts";
import type { BrowserMutationOptions } from "./browser-mutation.ts";
import {
  invalidResponse,
  requireNoContent,
  validatedResult,
  validatedResultForStatus
} from "./domain.ts";
import type { ApiEmptyResult, ApiResult, DomainRequestOptions } from "./domain.ts";
import type { ApiClient, ApiResponse } from "./types.ts";
import {
  readBoolean,
  readBoundedString,
  readEnum,
  readExactRecord,
  readPositiveInteger,
  readUtcTimestamp,
  readUuidV7
} from "./validation.ts";

const PROVIDER_KINDS = [
  "github",
  "github_enterprise",
  "gitlab",
  "gitlab_self_managed",
  "generic"
] as const;
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const CONNECTION_ETAG = /^"git-connection-v([1-9]\d*)"$/u;
const REMOTE_ETAG = /^"git-remote-((?:[0-9a-f]{40}|[0-9a-f]{64}))"$/u;
const MAX_TOKEN_BYTES = 60 * 1024;

export type GitProviderKind = (typeof PROVIDER_KINDS)[number];

export interface GitProvider {
  readonly id: string;
  readonly displayName: string;
  readonly kind: GitProviderKind;
  readonly host: string;
  readonly allowsWrite: boolean;
}

export interface GitConnection {
  readonly id: string;
  readonly providerId: string;
  readonly credentialVersion: number;
  readonly connectionVersion: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface GitRemote {
  readonly projectId: string;
  readonly providerId: string;
  readonly repositoryUrl: string;
  readonly branch: string;
  readonly remoteHeadSha: string;
  readonly remoteVersion: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface GitOperation {
  readonly remote: GitRemote;
  readonly previousHeadSha: string | null;
  readonly headSha: string;
  readonly changedObjects: number;
  readonly transferredBytes: number;
}

export interface GitProviderAdmin {
  readonly id: string;
  readonly displayName: string;
  readonly kind: GitProviderKind;
  readonly host: string;
  readonly port: number;
  readonly apiBaseUrl: string;
  readonly oauthAuthorizationUrl: string | null;
  readonly oauthTokenUrl: string | null;
  readonly oauthClientId: string | null;
  readonly state: "active" | "disabled";
  readonly allowsRead: boolean;
  readonly allowsWrite: boolean;
  readonly configVersion: number;
  readonly validatedAt: string | null;
}

export interface GitProviderAdminInput {
  readonly displayName: string;
  readonly kind: GitProviderKind;
  readonly host: string;
  readonly port: number;
  readonly apiBaseUrl: string;
  readonly oauthAuthorizationUrl: string | null;
  readonly oauthTokenUrl: string | null;
  readonly oauthClientId: string | null;
  readonly allowsRead: boolean;
  readonly allowsWrite: boolean;
}

export type GitProviderAdminUpdate = Omit<GitProviderAdminInput, "host" | "kind" | "port">;

export interface GitConnectionResult extends ApiResult<GitConnection> {
  readonly etag: string;
}

export interface GitRemoteResult extends ApiResult<GitRemote> {
  readonly etag: string;
}

export interface GitOperationResult extends ApiResult<GitOperation> {
  readonly etag: string;
}

export async function listGitProvidersForAdmin(client: ApiClient, options: DomainRequestOptions = {}): Promise<ApiResult<readonly GitProviderAdmin[]>> {
  return validatedResult(await client.get<unknown>("/admin/git-providers", options), (value) => parseBoundedCollection(value, parseAdminProvider));
}

export async function createGitProvider(client: ApiClient, input: GitProviderAdminInput, options: BrowserMutationOptions): Promise<ApiResult<GitProviderAdmin>> {
  return validatedResultForStatus(await client.post<unknown, GitProviderAdminInput>("/admin/git-providers", input, mutationOptions(options)), 201, parseAdminProvider);
}

export function updateGitProvider(client: ApiClient, id: string, version: number, input: GitProviderAdminUpdate, options: BrowserMutationOptions): Promise<ApiResult<GitProviderAdmin>> {
  return mutateProvider(client, "PATCH", id, version, input, options);
}

export function activateGitProvider(client: ApiClient, id: string, version: number, options: BrowserMutationOptions): Promise<ApiResult<GitProviderAdmin>> {
  return mutateProvider(client, "POST", id, version, undefined, options, "/activate");
}

export function disableGitProvider(client: ApiClient, id: string, version: number, options: BrowserMutationOptions): Promise<ApiResult<GitProviderAdmin>> {
  return mutateProvider(client, "POST", id, version, undefined, options, "/disable");
}

export async function deleteGitProvider(client: ApiClient, id: string, version: number, options: BrowserMutationOptions): Promise<ApiEmptyResult> {
  return requireNoContent(await client.delete<unknown>(`/admin/git-providers/${parseUuidInput(id)}`, mutationOptions(options, providerEtag(version))));
}

async function mutateProvider(client: ApiClient, method: "PATCH" | "POST", id: string, version: number, body: unknown, options: BrowserMutationOptions, suffix = ""): Promise<ApiResult<GitProviderAdmin>> {
  const path = `/admin/git-providers/${parseUuidInput(id)}${suffix}` as `/${string}`;
  const request = mutationOptions(options, providerEtag(version));
  const response = method === "PATCH" ? await client.patch<unknown, unknown>(path, body, request) : await client.post<unknown, unknown>(path, body, request);
  return validatedResult(response, parseAdminProvider);
}

function providerEtag(version: number): Headers {
  if (!Number.isSafeInteger(version) || version < 1) throw new TypeError("invalid Git provider version");
  return new Headers({ "if-match": `"git-provider-v${version}"` });
}

function parseAdminProvider(value: unknown): GitProviderAdmin {
  const record = readExactRecord(value, ["allowsRead", "allowsWrite", "apiBaseUrl", "configVersion", "displayName", "host", "id", "kind", "oauthAuthorizationUrl", "oauthClientId", "oauthTokenUrl", "port", "state", "validatedAt"]);
  if (typeof record.allowsRead !== "boolean" || typeof record.allowsWrite !== "boolean") throw new TypeError("invalid Git provider permissions");
  const nullable = (key: string, maximum: number) => record[key] === null ? null : readBoundedString(record, key, maximum);
  return {
    id: readUuidV7(record, "id"), displayName: readBoundedString(record, "displayName", 800, { maxCharacters: 200 }),
    kind: readEnum(record, "kind", PROVIDER_KINDS), host: readBoundedString(record, "host", 253),
    port: readPositiveInteger(record, "port", 65_535), apiBaseUrl: readBoundedString(record, "apiBaseUrl", 2_048),
    oauthAuthorizationUrl: nullable("oauthAuthorizationUrl", 2_048), oauthTokenUrl: nullable("oauthTokenUrl", 2_048),
    oauthClientId: nullable("oauthClientId", 1_024), state: readEnum(record, "state", ["active", "disabled"] as const),
    allowsRead: record.allowsRead, allowsWrite: record.allowsWrite, configVersion: readPositiveInteger(record, "configVersion"),
    validatedAt: record.validatedAt === null ? null : readUtcTimestamp(record, "validatedAt")
  };
}

export async function listGitProviders(
  client: ApiClient,
  options: DomainRequestOptions = {}
): Promise<ApiResult<readonly GitProvider[]>> {
  return validatedResult(await client.get<unknown>("/me/git-providers", options), (value) =>
    parseBoundedCollection(value, parseProvider)
  );
}

export async function listGitConnections(
  client: ApiClient,
  options: DomainRequestOptions = {}
): Promise<ApiResult<readonly GitConnection[]>> {
  return validatedResult(await client.get<unknown>("/me/git-connections", options), (value) =>
    parseBoundedCollection(value, parseConnection)
  );
}

export async function connectGitProvider(
  client: ApiClient,
  providerId: string,
  token: string,
  options: BrowserMutationOptions
): Promise<GitConnectionResult> {
  const response = await client.post<unknown, { providerId: string; token: string }>(
    "/me/git-connections",
    { providerId: parseUuidInput(providerId), token: validateToken(token) },
    mutationOptions(options)
  );
  return connectionResult(response, 201);
}

export async function rotateGitCredential(
  client: ApiClient,
  connection: Pick<GitConnectionResult, "etag"> & { readonly id: string },
  token: string,
  options: BrowserMutationOptions
): Promise<GitConnectionResult> {
  const id = parseUuidInput(connection.id);
  const response = await client.post<unknown, { token: string }>(
    `/me/git-connections/${id}/rotate`,
    { token: validateToken(token) },
    mutationOptions(options, { "if-match": validateConnectionEtag(connection.etag) })
  );
  return connectionResult(response, 200);
}

export async function disconnectGitProvider(
  client: ApiClient,
  connection: Pick<GitConnectionResult, "etag"> & { readonly id: string },
  options: BrowserMutationOptions
): Promise<ApiEmptyResult> {
  const id = parseUuidInput(connection.id);
  return requireNoContent(
    await client.delete<unknown>(
      `/me/git-connections/${id}`,
      mutationOptions(options, { "if-match": validateConnectionEtag(connection.etag) })
    )
  );
}

export async function getGitRemote(
  client: ApiClient,
  projectId: string,
  options: DomainRequestOptions = {}
): Promise<GitRemoteResult> {
  const response = await client.get<unknown>(`/projects/${parseUuidInput(projectId)}/git`, options);
  const result = validatedResult(response, parseRemote);
  return { ...result, etag: validateRemoteEtag(response, result.data.remoteHeadSha) };
}

export async function importGitRepository(
  client: ApiClient,
  input: {
    readonly projectId: string;
    readonly repositoryUrl: string;
    readonly branch: string;
  },
  options: BrowserMutationOptions
): Promise<GitOperationResult> {
  const response = await client.post<unknown, { repositoryUrl: string; branch: string }>(
    `/projects/${parseUuidInput(input.projectId)}/git/import`,
    { repositoryUrl: input.repositoryUrl, branch: input.branch },
    mutationOptions(options)
  );
  return operationResult(response, 201);
}

export async function pullGitRemote(
  client: ApiClient,
  projectId: string,
  etag: string,
  options: BrowserMutationOptions
): Promise<GitOperationResult> {
  const response = await client.post<unknown>(
    `/projects/${parseUuidInput(projectId)}/git/pull`,
    undefined,
    mutationOptions(options, { "if-match": validateRemoteEtagValue(etag) })
  );
  return operationResult(response, 200);
}

export async function commitAndPushGitRemote(
  client: ApiClient,
  input: { readonly projectId: string; readonly etag: string; readonly commitMessage: string },
  options: BrowserMutationOptions
): Promise<GitOperationResult> {
  const response = await client.post<unknown, { commitMessage: string }>(
    `/projects/${parseUuidInput(input.projectId)}/git/commit-push`,
    { commitMessage: input.commitMessage },
    mutationOptions(options, { "if-match": validateRemoteEtagValue(input.etag) })
  );
  return operationResult(response, 200);
}

function parseBoundedCollection<T>(value: unknown, parse: (value: unknown) => T): readonly T[] {
  if (!Array.isArray(value) || value.length > 100) throw new TypeError("invalid collection");
  return value.map(parse);
}

function parseProvider(value: unknown): GitProvider {
  const record = readExactRecord(value, ["allowsWrite", "displayName", "host", "id", "kind"]);
  return {
    id: readUuidV7(record, "id"),
    displayName: readBoundedString(record, "displayName", 800, { maxCharacters: 200 }),
    kind: readEnum(record, "kind", PROVIDER_KINDS),
    host: readBoundedString(record, "host", 512),
    allowsWrite: readBoolean(record, "allowsWrite")
  };
}

function parseConnection(value: unknown): GitConnection {
  const record = readExactRecord(value, [
    "connectionVersion",
    "createdAt",
    "credentialVersion",
    "id",
    "providerId",
    "updatedAt"
  ]);
  return {
    id: readUuidV7(record, "id"),
    providerId: readUuidV7(record, "providerId"),
    credentialVersion: readPositiveInteger(record, "credentialVersion"),
    connectionVersion: readPositiveInteger(record, "connectionVersion"),
    createdAt: readUtcTimestamp(record, "createdAt"),
    updatedAt: readUtcTimestamp(record, "updatedAt")
  };
}

function parseRemote(value: unknown): GitRemote {
  const record = readExactRecord(value, [
    "branch",
    "createdAt",
    "projectId",
    "providerId",
    "remoteHeadSha",
    "remoteVersion",
    "repositoryUrl",
    "updatedAt"
  ]);
  return {
    projectId: readUuidV7(record, "projectId"),
    providerId: readUuidV7(record, "providerId"),
    repositoryUrl: readBoundedString(record, "repositoryUrl", 2_048),
    branch: readBoundedString(record, "branch", 255),
    remoteHeadSha: readSha(record, "remoteHeadSha"),
    remoteVersion: readPositiveInteger(record, "remoteVersion"),
    createdAt: readUtcTimestamp(record, "createdAt"),
    updatedAt: readUtcTimestamp(record, "updatedAt")
  };
}

function parseOperation(value: unknown): GitOperation {
  const record = readExactRecord(value, [
    "changedObjects",
    "headSha",
    "previousHeadSha",
    "remote",
    "transferredBytes"
  ]);
  return {
    remote: parseRemote(record.remote),
    previousHeadSha: record.previousHeadSha === null ? null : readSha(record, "previousHeadSha"),
    headSha: readSha(record, "headSha"),
    changedObjects: readNonNegativeInteger(record, "changedObjects"),
    transferredBytes: readNonNegativeInteger(record, "transferredBytes")
  };
}

function connectionResult(response: ApiResponse<unknown>, status: 200 | 201): GitConnectionResult {
  const result = validatedResultForStatus(response, status, parseConnection);
  const etag = response.headers.get("etag");
  if (etag?.match(CONNECTION_ETAG)?.[1] !== String(result.data.connectionVersion)) {
    throw invalidResponse(response);
  }
  return { ...result, etag };
}

function operationResult(response: ApiResponse<unknown>, status: 200 | 201): GitOperationResult {
  const result = validatedResultForStatus(response, status, parseOperation);
  return { ...result, etag: validateRemoteEtag(response, result.data.remote.remoteHeadSha) };
}

function validateRemoteEtag(response: ApiResponse<unknown>, sha: string): string {
  const etag = response.headers.get("etag");
  if (etag?.match(REMOTE_ETAG)?.[1] !== sha) throw invalidResponse(response);
  return etag;
}

function validateConnectionEtag(value: string): string {
  if (!CONNECTION_ETAG.test(value)) throw new TypeError("invalid Git connection ETag");
  return value;
}

function validateRemoteEtagValue(value: string): string {
  if (!REMOTE_ETAG.test(value)) throw new TypeError("invalid Git remote ETag");
  return value;
}

function parseUuidInput(value: string): string {
  return readUuidV7({ value }, "value");
}

function validateToken(value: string): string {
  const bytes = new TextEncoder().encode(value);
  if (value.length === 0 || bytes.byteLength > MAX_TOKEN_BYTES || /[\u0000\r\n]/u.test(value)) {
    throw new TypeError("invalid Git credential");
  }
  return value;
}

function readSha(record: Record<string, unknown>, key: string): string {
  const value = readBoundedString(record, key, 64);
  if (!SHA.test(value)) throw new TypeError("invalid Git SHA");
  return value;
}

function readNonNegativeInteger(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new TypeError("invalid integer");
  return value as number;
}
