import { mutationOptions } from "./browser-mutation.ts";
import type { BrowserMutationOptions } from "./browser-mutation.ts";
import { requireNoContent, validatedResult } from "./domain.ts";
import type { ApiEmptyResult, ApiResult, DomainRequestOptions } from "./domain.ts";
import type { ApiClient } from "./types.ts";
import {
  readBoundedArray,
  readBoundedString,
  readEnum,
  readExactRecord,
  readNullableUtcTimestamp,
  readPositiveInteger,
  readUuidV7
} from "./validation.ts";

const STATES = ["active", "disabled"] as const;

export interface RegistryConnection {
  readonly id: string;
  readonly displayName: string;
  readonly baseUrl: string;
  readonly state: (typeof STATES)[number];
  readonly isDefault: boolean;
  readonly configVersion: number;
  readonly credentialVersion: number;
  readonly validatedAt: string | null;
}

export interface RegistryScopeRoute {
  readonly scope: string;
  readonly connectionId: string;
}

export interface RegistryConfiguration {
  readonly items: readonly RegistryConnection[];
  readonly scopes: readonly RegistryScopeRoute[];
}

export interface CreateRegistryInput {
  readonly displayName: string;
  readonly baseUrl: string;
  readonly token: string;
}

export async function listRegistries(
  client: ApiClient,
  options: DomainRequestOptions = {}
): Promise<ApiResult<RegistryConfiguration>> {
  return validatedResult(
    await client.get<unknown>("/admin/registries", options),
    parseCollection
  );
}

export async function createRegistry(
  client: ApiClient,
  input: CreateRegistryInput,
  options: BrowserMutationOptions
): Promise<ApiResult<RegistryConnection>> {
  return validatedResult(
    await client.post<unknown, CreateRegistryInput>(
      "/admin/registries",
      input,
      mutationOptions(options)
    ),
    parseRegistry
  );
}

export function renameRegistry(
  client: ApiClient,
  id: string,
  version: number,
  displayName: string,
  options: BrowserMutationOptions
): Promise<ApiResult<RegistryConnection>> {
  return mutate(client, "PATCH", id, version, { displayName }, options);
}

export function rotateRegistryToken(
  client: ApiClient,
  id: string,
  version: number,
  token: string,
  options: BrowserMutationOptions
): Promise<ApiResult<RegistryConnection>> {
  return mutate(client, "POST", id, version, { token }, options, "/rotate-token");
}

export function activateRegistry(
  client: ApiClient,
  id: string,
  version: number,
  options: BrowserMutationOptions
): Promise<ApiResult<RegistryConnection>> {
  return mutate(client, "POST", id, version, undefined, options, "/activate");
}

export function disableRegistry(
  client: ApiClient,
  id: string,
  version: number,
  options: BrowserMutationOptions
): Promise<ApiResult<RegistryConnection>> {
  return mutate(client, "POST", id, version, undefined, options, "/disable");
}

export function setDefaultRegistry(
  client: ApiClient,
  id: string,
  version: number,
  options: BrowserMutationOptions
): Promise<ApiResult<RegistryConnection>> {
  return mutate(client, "POST", id, version, undefined, options, "/default");
}

export async function mapRegistryScope(
  client: ApiClient,
  scope: string,
  connectionId: string,
  options: BrowserMutationOptions
): Promise<ApiEmptyResult> {
  const validId = readUuidV7({ id: connectionId }, "id");
  return requireNoContent(
    await client.post<unknown, { scope: string; connectionId: string }>(
      "/admin/registry-scopes",
      { scope, connectionId: validId },
      mutationOptions(options)
    )
  );
}

export async function deleteRegistry(
  client: ApiClient,
  id: string,
  version: number,
  options: BrowserMutationOptions
): Promise<ApiEmptyResult> {
  const validId = readUuidV7({ id }, "id");
  return requireNoContent(
    await client.delete<unknown>(
      `/admin/registries/${validId}`,
      mutationOptions(options, registryEtag(version))
    )
  );
}

async function mutate(
  client: ApiClient,
  method: "PATCH" | "POST",
  id: string,
  version: number,
  body: unknown,
  options: BrowserMutationOptions,
  suffix = ""
): Promise<ApiResult<RegistryConnection>> {
  const validId = readUuidV7({ id }, "id");
  const path = `/admin/registries/${validId}${suffix}` as `/${string}`;
  const requestOptions = mutationOptions(options, registryEtag(version));
  const result = method === "PATCH"
    ? await client.patch<unknown, unknown>(path, body, requestOptions)
    : await client.post<unknown, unknown>(path, body, requestOptions);
  return validatedResult(result, parseRegistry);
}

function registryEtag(version: number): Headers {
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new TypeError("invalid Registry version");
  }
  return new Headers({ "if-match": `"registry-v${version}"` });
}

function parseCollection(value: unknown): RegistryConfiguration {
  const record = readExactRecord(value, ["items", "scopes"]);
  return {
    items: readBoundedArray(record, "items", 100).map(parseRegistry),
    scopes: readBoundedArray(record, "scopes", 256).map((item) => {
      const scope = readExactRecord(item, ["connectionId", "scope"]);
      return {
        scope: readBoundedString(scope, "scope", 65),
        connectionId: readUuidV7(scope, "connectionId")
      };
    })
  };
}

function parseRegistry(value: unknown): RegistryConnection {
  const record = readExactRecord(value, [
    "baseUrl",
    "configVersion",
    "credentialVersion",
    "displayName",
    "id",
    "isDefault",
    "state",
    "validatedAt"
  ]);
  if (typeof record.isDefault !== "boolean") {
    throw new TypeError("invalid default state");
  }
  return {
    id: readUuidV7(record, "id"),
    displayName: readBoundedString(record, "displayName", 800, { maxCharacters: 200 }),
    baseUrl: readBoundedString(record, "baseUrl", 2048),
    state: readEnum(record, "state", STATES),
    isDefault: record.isDefault,
    configVersion: readPositiveInteger(record, "configVersion"),
    credentialVersion: readPositiveInteger(record, "credentialVersion"),
    validatedAt: readNullableUtcTimestamp(record, "validatedAt")
  };
}
