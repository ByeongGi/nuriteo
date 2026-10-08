import { mutationOptions, validateHeaderValue } from "./browser-mutation.ts";
import type { BrowserMutationOptions } from "./browser-mutation.ts";
import { validatedResult, validatedResultForStatus } from "./domain.ts";
import type { ApiResult, DomainRequestOptions } from "./domain.ts";
import type { ApiClient } from "./types.ts";
import {
  readBoundedArray,
  readBoundedString,
  readEnum,
  readExactRecord,
  readPositiveInteger,
  readUtcTimestamp,
  readUuidV7
} from "./validation.ts";

const TYPES = ["oidc", "smtp", "git_provider", "registry"] as const;
const STATES = ["candidate", "active", "retired"] as const;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{16,128}$/u;
const FINGERPRINT = /^[0-9a-f]{64}$/u;

export type IntegrationCaType = (typeof TYPES)[number];
export type IntegrationCaState = (typeof STATES)[number];

export interface IntegrationCaBundle {
  readonly id: string;
  readonly integrationType: IntegrationCaType;
  readonly integrationId: string;
  readonly version: number;
  readonly state: IntegrationCaState;
  readonly fingerprints: readonly string[];
  readonly earliestExpiry: string;
}

export interface IntegrationCaCollection {
  readonly items: readonly IntegrationCaBundle[];
  readonly version: number;
}

export interface IntegrationCaMutationOptions extends BrowserMutationOptions {
  readonly idempotencyKey: string;
}

export async function listIntegrationCas(
  client: ApiClient,
  type: IntegrationCaType,
  integrationId: string,
  options: DomainRequestOptions = {}
): Promise<ApiResult<IntegrationCaCollection>> {
  return validatedResult(
    await client.get<unknown>(path(type, integrationId), options),
    parseCollection
  );
}

export async function stageIntegrationCa(
  client: ApiClient,
  type: IntegrationCaType,
  integrationId: string,
  version: number,
  pem: string,
  options: IntegrationCaMutationOptions
): Promise<ApiResult<IntegrationCaBundle>> {
  if (new TextEncoder().encode(pem).byteLength > 1_048_576 || pem.length === 0) {
    throw new TypeError("invalid CA bundle");
  }
  const response = await client.post<unknown, { readonly pem: string }>(
    `${path(type, integrationId)}/candidates`,
    { pem },
    requestOptions(version, options)
  );
  return validatedResultForStatus(response, 201, parseBundle);
}

export async function activateIntegrationCa(
  client: ApiClient,
  type: IntegrationCaType,
  integrationId: string,
  candidateId: string,
  version: number,
  options: IntegrationCaMutationOptions
): Promise<ApiResult<IntegrationCaBundle>> {
  const id = readUuidV7({ id: candidateId }, "id");
  return validatedResult(
    await client.post<unknown>(
      `${path(type, integrationId)}/candidates/${id}/activate`,
      undefined,
      requestOptions(version, options)
    ),
    parseBundle
  );
}

function path(type: IntegrationCaType, integrationId: string): `/${string}` {
  if (!TYPES.includes(type) || !SAFE_ID.test(integrationId)) {
    throw new TypeError("invalid integration CA identity");
  }
  return `/admin/integrations/${type}/${encodeURIComponent(integrationId)}/ca`;
}

function requestOptions(version: number, options: IntegrationCaMutationOptions) {
  if (!Number.isSafeInteger(version) || version < 0) {
    throw new TypeError("invalid integration CA version");
  }
  validateHeaderValue(options.idempotencyKey, "idempotency key");
  if (!IDEMPOTENCY_KEY.test(options.idempotencyKey)) {
    throw new TypeError("invalid idempotency key");
  }
  const headers = new Headers({
    "idempotency-key": options.idempotencyKey,
    "if-match": `"integration-ca-v${version}"`
  });
  const { idempotencyKey: _, ...browserOptions } = options;
  return mutationOptions(browserOptions, headers);
}

function parseCollection(value: unknown): IntegrationCaCollection {
  const record = readExactRecord(value, ["items", "version"]);
  const version = record.version;
  if (!Number.isSafeInteger(version) || (version as number) < 0) {
    throw new TypeError("invalid integration CA collection version");
  }
  return {
    items: readBoundedArray(record, "items", 128).map(parseBundle),
    version: version as number
  };
}

function parseBundle(value: unknown): IntegrationCaBundle {
  const record = readExactRecord(value, [
    "earliestExpiry",
    "fingerprints",
    "id",
    "integrationId",
    "integrationType",
    "state",
    "version"
  ]);
  const fingerprints = readBoundedArray(record, "fingerprints", 64).map((value) => {
    const fingerprint = readBoundedString({ value }, "value", 64);
    if (!FINGERPRINT.test(fingerprint)) throw new TypeError("invalid CA fingerprint");
    return fingerprint;
  });
  if (fingerprints.length === 0) throw new TypeError("missing CA fingerprint");
  return {
    id: readUuidV7(record, "id"),
    integrationType: readEnum(record, "integrationType", TYPES),
    integrationId: readBoundedString(record, "integrationId", 128),
    version: readPositiveInteger(record, "version"),
    state: readEnum(record, "state", STATES),
    fingerprints,
    earliestExpiry: readUtcTimestamp(record, "earliestExpiry")
  };
}
