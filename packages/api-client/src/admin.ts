import { mutationOptions } from "./browser-mutation.ts";
import type { BrowserMutationOptions } from "./browser-mutation.ts";
import {
  type ApiResult,
  type DomainRequestOptions,
  validatedResult
} from "./domain.ts";
import type { ApiClient } from "./types.ts";
import {
  readBoolean,
  readBoundedArray,
  readBoundedString,
  readEnum,
  readExactRecord,
  readPositiveInteger
} from "./validation.ts";

const MAX_SETTINGS = 100;
const MAX_SETTING_KEY_BYTES = 128;
const MAX_SETTING_STRING_BYTES = 128;
const APPLY_MODES = ["live", "new_runtime", "server_restart"] as const;
const SETTING_KEY = /^[a-z][a-z0-9_.-]{0,127}$/u;

export type AdminSettingApplyMode = (typeof APPLY_MODES)[number];
export type AdminSettingValue = string | number | null;

export interface AdminSetting {
  readonly key: string;
  readonly value: AdminSettingValue;
  readonly version: number;
  readonly applyMode: AdminSettingApplyMode;
}

export interface AdminSettingCollection {
  readonly registryVersion: number;
  readonly items: readonly AdminSetting[];
}

export interface AdminStatus {
  readonly releaseVersion: string;
  readonly schemaVersion: number;
  readonly settingRegistryVersion: number;
  readonly settingCount: number;
  readonly restartRequired: boolean;
}

export interface UpdateAdminSettingInput {
  readonly key: string;
  readonly value: AdminSettingValue;
  readonly version: number;
}

export async function listAdminSettings(
  client: ApiClient,
  options: DomainRequestOptions = {}
): Promise<ApiResult<AdminSettingCollection>> {
  const response = await client.get<unknown>("/admin/settings", options);
  return validatedResult(response, parseSettingCollection);
}

export async function getAdminStatus(
  client: ApiClient,
  options: DomainRequestOptions = {}
): Promise<ApiResult<AdminStatus>> {
  const response = await client.get<unknown>("/admin/status", options);
  return validatedResult(response, parseStatus);
}

export async function updateAdminSetting(
  client: ApiClient,
  input: UpdateAdminSettingInput,
  options: BrowserMutationOptions
): Promise<ApiResult<AdminSetting>> {
  const key = validatedSettingKey(input.key);
  const version = validatedPositiveInteger(input.version, "setting version");
  const value = validatedSettingValue(input.value);
  const response = await client.patch<unknown, { readonly value: AdminSettingValue }>(
    `/admin/settings/${key}`,
    { value },
    mutationOptions(options, { "if-match": `"setting-v${version}"` })
  );
  return validatedResult(response, parseSetting);
}

function parseSettingCollection(value: unknown): AdminSettingCollection {
  const record = readExactRecord(value, ["items", "registryVersion"]);
  const items = readBoundedArray(record, "items", MAX_SETTINGS).map(parseSetting);
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.key)) throw new TypeError("duplicate setting key");
    seen.add(item.key);
  }
  return {
    registryVersion: readPositiveInteger(record, "registryVersion", 65_535),
    items
  };
}

function parseSetting(value: unknown): AdminSetting {
  const record = readExactRecord(value, ["applyMode", "key", "value", "version"]);
  return {
    key: validatedSettingKey(readBoundedString(record, "key", MAX_SETTING_KEY_BYTES)),
    value: validatedSettingValue(record.value),
    version: readPositiveInteger(record, "version"),
    applyMode: readEnum(record, "applyMode", APPLY_MODES)
  };
}

function parseStatus(value: unknown): AdminStatus {
  const record = readExactRecord(value, [
    "releaseVersion",
    "restartRequired",
    "schemaVersion",
    "settingCount",
    "settingRegistryVersion"
  ]);
  return {
    releaseVersion: readBoundedString(record, "releaseVersion", 128),
    schemaVersion: readNonNegativeInteger(record.schemaVersion, "schema version"),
    settingRegistryVersion: readPositiveInteger(record, "settingRegistryVersion", 65_535),
    settingCount: readNonNegativeInteger(record.settingCount, "setting count"),
    restartRequired: readBoolean(record, "restartRequired")
  };
}

function validatedSettingKey(value: string): string {
  if (!SETTING_KEY.test(value) || new TextEncoder().encode(value).byteLength > MAX_SETTING_KEY_BYTES) {
    throw new TypeError("invalid setting key");
  }
  return value;
}

function validatedSettingValue(value: unknown): AdminSettingValue {
  if (value === null) return null;
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (
    typeof value === "string" &&
    value.length > 0 &&
    new TextEncoder().encode(value).byteLength <= MAX_SETTING_STRING_BYTES &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  ) {
    return value;
  }
  throw new TypeError("invalid setting value");
}

function validatedPositiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new TypeError(`invalid ${label}`);
  }
  return value as number;
}

function readNonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`invalid ${label}`);
  }
  return value as number;
}
