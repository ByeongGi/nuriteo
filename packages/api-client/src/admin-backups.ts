import { type ApiResult, type DomainRequestOptions, validatedResult, validatedResultForStatus } from "./domain.ts";
import type { ApiClient, ApiRequestOptions } from "./types.ts";
import {
  readBoolean,
  readBoundedArray,
  readBoundedString,
  readEnum,
  readNullableUtcTimestamp,
  readNullableUuidV7,
  readPositiveInteger,
  readUtcTimestamp,
  readUuidV7
} from "./validation.ts";

const DRILL_FREQUENCIES = ["off", "weekly", "monthly", "quarterly"] as const;
const OPERATION_KINDS = ["create", "verify", "drill", "prune"] as const;
const OPERATION_STATES = ["queued", "running", "succeeded", "failed", "cancelled"] as const;
const ALERT_LEVELS = ["warning", "critical"] as const;

export interface AdminBackupPolicy {
  readonly enabled: boolean;
  readonly intervalHours: number;
  readonly scheduleTime: string;
  readonly scheduleTimezone: string;
  readonly dailyRetention: number | null;
  readonly weeklyRetention: number | null;
  readonly monthlyRetention: number | null;
  readonly failedRetentionDays: number;
  readonly multipartCleanupHours: number;
  readonly warningAfterHours: number;
  readonly criticalAfterFailures: number;
  readonly drillFrequency: (typeof DRILL_FREQUENCIES)[number];
  readonly drillTime: string;
  readonly drillTimezone: string;
  readonly version: number;
}

export type AdminBackupPolicyUpdate = Omit<AdminBackupPolicy, "version">;
export type AdminBackupOperationKind = (typeof OPERATION_KINDS)[number];

export interface AdminBackupConsole {
  readonly policy: AdminBackupPolicy;
  readonly restorePoints: readonly {
    readonly id: string;
    readonly releaseVersion: string;
    readonly schemaVersion: number;
    readonly objectCount: number;
    readonly payloadBytes: string;
    readonly completedAt: string;
    readonly retainedAs: readonly string[];
  }[];
  readonly operations: readonly {
    readonly id: string;
    readonly kind: AdminBackupOperationKind;
    readonly source: "manual" | "schedule";
    readonly backupId: string | null;
    readonly state: (typeof OPERATION_STATES)[number];
    readonly failureCode: string | null;
    readonly requestedAt: string;
    readonly startedAt: string | null;
    readonly completedAt: string | null;
  }[];
  readonly alerts: readonly {
    readonly level: (typeof ALERT_LEVELS)[number];
    readonly code: string;
    readonly message: string;
  }[];
  readonly pruneCandidates: number;
}

export async function getAdminBackups(
  client: ApiClient,
  options: DomainRequestOptions = {}
): Promise<ApiResult<AdminBackupConsole>> {
  return validatedResult(await client.get<unknown>("/admin/backups", options), parseConsole);
}

export async function updateAdminBackupPolicy(
  client: ApiClient,
  input: AdminBackupPolicyUpdate,
  options: Omit<ApiRequestOptions<AdminBackupPolicyUpdate>, "body"> = {}
): Promise<ApiResult<AdminBackupConsole>> {
  return validatedResult(
    await client.put<unknown, AdminBackupPolicyUpdate>("/admin/backups/policy", input, options),
    parseConsole
  );
}

export async function enqueueAdminBackupOperation(
  client: ApiClient,
  input: { readonly kind: AdminBackupOperationKind; readonly backupId: string | null },
  options: Omit<ApiRequestOptions<typeof input>, "body"> = {}
): Promise<ApiResult<AdminBackupConsole>> {
  return validatedResultForStatus(
    await client.post<unknown, typeof input>("/admin/backups/operations", input, options),
    202,
    parseConsole
  );
}

function parseConsole(value: unknown): AdminBackupConsole {
  const record = readExact(value, ["alerts", "operations", "policy", "pruneCandidates", "restorePoints"]);
  return {
    policy: parsePolicy(record.policy),
    restorePoints: readBoundedArray(record, "restorePoints", 50).map(parseRestorePoint),
    operations: readBoundedArray(record, "operations", 20).map(parseOperation),
    alerts: readBoundedArray(record, "alerts", 10).map(parseAlert),
    pruneCandidates: readNonNegative(record, "pruneCandidates")
  };
}

function parsePolicy(value: unknown): AdminBackupPolicy {
  const record = readExact(value, [
    "criticalAfterFailures", "dailyRetention", "drillFrequency", "drillTime", "drillTimezone",
    "enabled", "failedRetentionDays", "intervalHours", "monthlyRetention", "multipartCleanupHours", "scheduleTime", "scheduleTimezone",
    "version", "warningAfterHours", "weeklyRetention"
  ]);
  return {
    enabled: readBoolean(record, "enabled"),
    intervalHours: readPositiveInteger(record, "intervalHours", 168),
    scheduleTime: readTime(record, "scheduleTime"),
    scheduleTimezone: readBoundedString(record, "scheduleTimezone", 128),
    dailyRetention: readNullableNonNegative(record, "dailyRetention", 365),
    weeklyRetention: readNullableNonNegative(record, "weeklyRetention", 104),
    monthlyRetention: readNullableNonNegative(record, "monthlyRetention", 120),
    failedRetentionDays: readPositiveInteger(record, "failedRetentionDays", 90),
    multipartCleanupHours: readPositiveInteger(record, "multipartCleanupHours", 168),
    warningAfterHours: readPositiveInteger(record, "warningAfterHours", 720),
    criticalAfterFailures: readPositiveInteger(record, "criticalAfterFailures", 100),
    drillFrequency: readEnum(record, "drillFrequency", DRILL_FREQUENCIES),
    drillTime: readTime(record, "drillTime"),
    drillTimezone: readBoundedString(record, "drillTimezone", 128),
    version: readPositiveInteger(record, "version")
  };
}

function parseRestorePoint(value: unknown) {
  const record = readExact(value, ["completedAt", "id", "objectCount", "payloadBytes", "releaseVersion", "retainedAs", "schemaVersion"]);
  return {
    id: readUuidV7(record, "id"),
    releaseVersion: readBoundedString(record, "releaseVersion", 128),
    schemaVersion: readPositiveInteger(record, "schemaVersion"),
    objectCount: readPositiveInteger(record, "objectCount"),
    payloadBytes: readDecimal(record, "payloadBytes"),
    completedAt: readUtcTimestamp(record, "completedAt"),
    retainedAs: readBoundedArray(record, "retainedAs", 4).map((item) => {
      if (typeof item !== "string" || !["daily", "weekly", "monthly", "pinned"].includes(item)) throw new TypeError("invalid retention class");
      return item;
    })
  };
}

function parseOperation(value: unknown) {
  const record = readExact(value, ["backupId", "completedAt", "failureCode", "id", "kind", "requestedAt", "source", "startedAt", "state"]);
  return {
    id: readUuidV7(record, "id"),
    kind: readEnum(record, "kind", OPERATION_KINDS),
    source: readEnum(record, "source", ["manual", "schedule"] as const),
    backupId: readNullableUuidV7(record, "backupId"),
    state: readEnum(record, "state", OPERATION_STATES),
    failureCode: record.failureCode === null ? null : readBoundedString(record, "failureCode", 128),
    requestedAt: readUtcTimestamp(record, "requestedAt"),
    startedAt: readNullableUtcTimestamp(record, "startedAt"),
    completedAt: readNullableUtcTimestamp(record, "completedAt")
  };
}

function parseAlert(value: unknown) {
  const record = readExact(value, ["code", "level", "message"]);
  return {
    level: readEnum(record, "level", ALERT_LEVELS),
    code: readBoundedString(record, "code", 128),
    message: readBoundedString(record, "message", 512)
  };
}

function readExact(value: unknown, keys: readonly string[]) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError("invalid record");
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).toSorted();
  if (actual.length !== keys.length || actual.some((key, index) => key !== [...keys].toSorted()[index])) throw new TypeError("invalid fields");
  return record;
}

function readNonNegative(record: Record<string, unknown>, key: string, maximum = Number.MAX_SAFE_INTEGER) {
  const value = record[key];
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) throw new TypeError("invalid integer");
  return value as number;
}

function readNullableNonNegative(record: Record<string, unknown>, key: string, maximum: number) {
  return record[key] === null ? null : readNonNegative(record, key, maximum);
}

function readTime(record: Record<string, unknown>, key: string) {
  const value = readBoundedString(record, key, 5);
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(value)) throw new TypeError("invalid time");
  return value;
}

function readDecimal(record: Record<string, unknown>, key: string) {
  const value = readBoundedString(record, key, 20);
  if (!/^(?:0|[1-9]\d{0,19})$/u.test(value)) throw new TypeError("invalid decimal");
  return value;
}
