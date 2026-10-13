const UUID_V7_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const UTC_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u;
const OFFSET_DATE_TIME_UTC_PATTERN =
  /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?) \+00:00:00$/u;

const encoder = new TextEncoder();

export function readExactRecord(
  value: unknown,
  expectedKeys: readonly string[]
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("invalid record");
  }
  const record = value as Record<string, unknown>;
  const actualKeys = Object.keys(record).toSorted();
  const requiredKeys = [...expectedKeys].toSorted();
  if (
    actualKeys.length !== requiredKeys.length ||
    actualKeys.some((key, index) => key !== requiredKeys[index])
  ) {
    throw new TypeError("invalid fields");
  }
  return record;
}

export function readBoundedString(
  record: Record<string, unknown>,
  key: string,
  maxBytes: number,
  options: { readonly allowEmpty?: boolean; readonly maxCharacters?: number } = {}
): string {
  const value = record[key];
  if (
    typeof value !== "string" ||
    (!options.allowEmpty && value.length === 0) ||
    (options.maxCharacters !== undefined && [...value].length > options.maxCharacters) ||
    encoder.encode(value).byteLength > maxBytes ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new TypeError("invalid string");
  }
  return value;
}

export function readBoolean(record: Record<string, unknown>, key: string): boolean {
  const value = record[key];
  if (typeof value !== "boolean") {
    throw new TypeError("invalid boolean");
  }
  return value;
}

export function readUuidV7(record: Record<string, unknown>, key: string): string {
  const value = readBoundedString(record, key, 36);
  if (!UUID_V7_PATTERN.test(value)) {
    throw new TypeError("invalid UUID");
  }
  return value;
}

export function readUtcTimestamp(record: Record<string, unknown>, key: string): string {
  const value = readBoundedString(record, key, 64);
  if (UTC_TIMESTAMP_PATTERN.test(value) && Number.isFinite(Date.parse(value))) {
    return value;
  }
  const alternate = value.match(OFFSET_DATE_TIME_UTC_PATTERN);
  const normalized = alternate === null ? undefined : `${alternate[1]}T${alternate[2]}Z`;
  if (normalized === undefined || !Number.isFinite(Date.parse(normalized))) {
    throw new TypeError("invalid timestamp");
  }
  return normalized;
}

export function readNullableUtcTimestamp(
  record: Record<string, unknown>,
  key: string
): string | null {
  if (record[key] === null) {
    return null;
  }
  return readUtcTimestamp(record, key);
}

export function readNullableUuidV7(
  record: Record<string, unknown>,
  key: string
): string | null {
  if (record[key] === null) {
    return null;
  }
  return readUuidV7(record, key);
}

export function readEnum<const T extends string>(
  record: Record<string, unknown>,
  key: string,
  values: readonly T[]
): T {
  const value = readBoundedString(record, key, 64);
  if (!values.includes(value as T)) {
    throw new TypeError("invalid enum");
  }
  return value as T;
}

export function readPositiveInteger(
  record: Record<string, unknown>,
  key: string,
  maximum = Number.MAX_SAFE_INTEGER
): number {
  const value = record[key];
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum) {
    throw new TypeError("invalid integer");
  }
  return value as number;
}

export function readBoundedArray(
  record: Record<string, unknown>,
  key: string,
  maxItems: number
): readonly unknown[] {
  const value = record[key];
  if (!Array.isArray(value) || value.length > maxItems) {
    throw new TypeError("invalid array");
  }
  return value;
}
