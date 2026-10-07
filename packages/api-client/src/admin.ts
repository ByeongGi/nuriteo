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
const POLICY_CATEGORIES = [
  "audit", "identity", "notification", "object_storage", "project", "runtime", "security",
  "token", "workspace"
] as const;
const CONSTRAINT_KINDS = [
  "boolean", "unsigned_integer", "optional_unsigned_integer", "enumeration", "retention_days",
  "ascii_hostname", "email_address", "text"
] as const;
const SETTING_KEY = /^[a-z][a-z0-9_.-]{0,127}$/u;

export type AdminSettingApplyMode = (typeof APPLY_MODES)[number];
export type AdminSettingValue = string | number | boolean | null;
export type AdminSettingPolicyCategory = (typeof POLICY_CATEGORIES)[number];
export type AdminSettingConstraint =
  | { readonly kind: "boolean" | "ascii_hostname" | "email_address" }
  | { readonly kind: "unsigned_integer" | "optional_unsigned_integer"; readonly minimum: number; readonly maximum: number }
  | { readonly kind: "enumeration"; readonly allowed: readonly string[] }
  | { readonly kind: "retention_days"; readonly minimum: number; readonly maximum: number; readonly allowUnlimited: boolean }
  | { readonly kind: "text"; readonly minimumBytes: number; readonly maximumBytes: number };

export interface AdminSetting {
  readonly key: string;
  readonly value: AdminSettingValue;
  readonly defaultValue: AdminSettingValue;
  readonly version: number;
  readonly applyMode: AdminSettingApplyMode;
  readonly constraint: AdminSettingConstraint;
  readonly policyCategory: AdminSettingPolicyCategory | null;
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
  const record = readExactRecord(value, [
    "applyMode", "constraint", "defaultValue", "key", "policyCategory", "value", "version"
  ]);
  return {
    key: validatedSettingKey(readBoundedString(record, "key", MAX_SETTING_KEY_BYTES)),
    value: validatedSettingValue(record.value),
    defaultValue: validatedSettingValue(record.defaultValue),
    version: readPositiveInteger(record, "version"),
    applyMode: readEnum(record, "applyMode", APPLY_MODES),
    constraint: parseConstraint(record.constraint),
    policyCategory: record.policyCategory === null
      ? null
      : readEnum(record, "policyCategory", POLICY_CATEGORIES)
  };
}

function parseConstraint(value: unknown): AdminSettingConstraint {
  const kindRecord = readExactRecordWithKnownKind(value);
  const kind = readEnum(kindRecord, "kind", CONSTRAINT_KINDS);
  if (kind === "boolean" || kind === "ascii_hostname" || kind === "email_address") {
    readExactRecord(value, ["kind"]);
    return { kind };
  }
  if (kind === "enumeration") {
    const record = readExactRecord(value, ["allowed", "kind"]);
    const allowed = readBoundedArray(record, "allowed", 32).map((entry) => {
      if (typeof entry !== "string" || entry.length === 0 || entry.length > 128) {
        throw new TypeError("invalid setting constraint option");
      }
      return entry;
    });
    if (allowed.length === 0 || new Set(allowed).size !== allowed.length) {
      throw new TypeError("invalid setting constraint options");
    }
    return { kind, allowed };
  }
  if (kind === "retention_days") {
    const record = readExactRecord(value, ["allow_unlimited", "kind", "maximum", "minimum"]);
    const minimum = readNonNegativeInteger(record.minimum, "constraint minimum");
    const maximum = readNonNegativeInteger(record.maximum, "constraint maximum");
    if (minimum > maximum) throw new TypeError("invalid setting constraint range");
    return {
      kind,
      minimum,
      maximum,
      allowUnlimited: readBoolean(record, "allow_unlimited")
    };
  }
  if (kind === "text") {
    const record = readExactRecord(value, ["kind", "maximum_bytes", "minimum_bytes"]);
    const minimumBytes = readNonNegativeInteger(record.minimum_bytes, "constraint minimum bytes");
    const maximumBytes = readNonNegativeInteger(record.maximum_bytes, "constraint maximum bytes");
    if (minimumBytes > maximumBytes) throw new TypeError("invalid setting constraint range");
    return { kind, minimumBytes, maximumBytes };
  }
  const record = readExactRecord(value, ["kind", "maximum", "minimum"]);
  const minimum = readNonNegativeInteger(record.minimum, "constraint minimum");
  const maximum = readNonNegativeInteger(record.maximum, "constraint maximum");
  if (minimum > maximum) throw new TypeError("invalid setting constraint range");
  return { kind, minimum, maximum };
}

function readExactRecordWithKnownKind(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("invalid setting constraint");
  }
  return value as Record<string, unknown>;
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
  if (typeof value === "boolean") return value;
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
