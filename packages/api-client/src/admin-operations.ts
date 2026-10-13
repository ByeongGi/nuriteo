import { type ApiResult, type DomainRequestOptions, validatedResult } from "./domain.ts";
import type { ApiClient } from "./types.ts";
import {
  readBoundedArray,
  readBoundedString,
  readEnum,
  readExactRecord,
  readUtcTimestamp
} from "./validation.ts";

const STATES = ["nominal", "degraded", "unavailable"] as const;
const DEPENDENCY_CATEGORIES = [
  "configuration",
  "capacity",
  "deadline",
  "database_timeout",
  "database",
  "schema_pending",
  "schema_dirty",
  "schema_checksum_mismatch",
  "schema_unsupported",
  "object_storage_timeout",
  "object_storage"
] as const;

export type AdminOperationsState = (typeof STATES)[number];
export type AdminDependencyCategory = (typeof DEPENDENCY_CATEGORIES)[number];

export interface AdminDependencyStatus {
  readonly state: AdminOperationsState;
  readonly category: AdminDependencyCategory | null;
}

export interface AdminCleanupQueue {
  readonly state: AdminOperationsState;
  readonly queueDepth: number | null;
  readonly oldestEligibleAgeSeconds: number | null;
  readonly runningCount: number | null;
  readonly retryCount: number | null;
  readonly failedCount: number | null;
}

export interface AdminUsage {
  readonly state: AdminOperationsState;
  readonly activeUsers: number | null;
  readonly activeOrganizations: number | null;
  readonly activeProjects: number | null;
  readonly verifiedBundles: number | null;
  readonly trackedPhysicalBytes: string | null;
  readonly reservedBytes: string | null;
}

export interface AdminOperations {
  readonly generatedAt: string;
  readonly overallState: AdminOperationsState;
  readonly dependencies: AdminDependencyStatus;
  readonly cleanup: AdminCleanupQueue;
  readonly usage: AdminUsage;
  readonly supportBundle: AdminSupportBundlePreview;
}

export interface AdminSupportBundlePreview {
  readonly format: "nuriteo-support-bundle-v1+json";
  readonly maximumBytes: number;
  readonly includes: readonly string[];
  readonly excludes: readonly string[];
}

export async function getAdminOperations(
  client: ApiClient,
  options: DomainRequestOptions = {}
): Promise<ApiResult<AdminOperations>> {
  const response = await client.get<unknown>("/admin/operations", options);
  return validatedResult(response, parseOperations);
}

function parseOperations(value: unknown): AdminOperations {
  const record = readExactRecord(value, [
    "cleanup",
    "dependencies",
    "generatedAt",
    "overallState",
    "supportBundle",
    "usage"
  ]);
  const overallState = readEnum(record, "overallState", STATES);
  const dependencies = parseDependencies(record.dependencies);
  const cleanup = parseCleanup(record.cleanup);
  const usage = parseUsage(record.usage);
  const supportBundle = parseSupportBundlePreview(record.supportBundle);
  const expectedOverall = dependencies.state === "nominal" &&
    cleanup.state === "nominal" && usage.state === "nominal"
    ? "nominal"
    : "degraded";
  if (overallState !== expectedOverall) {
    throw new TypeError("invalid overall operations state");
  }
  return {
    generatedAt: readUtcTimestamp(record, "generatedAt"),
    overallState,
    dependencies,
    cleanup,
    usage,
    supportBundle
  };
}

function parseSupportBundlePreview(value: unknown): AdminSupportBundlePreview {
  const record = readExactRecord(value, ["excludes", "format", "includes", "maximumBytes"]);
  const format = readBoundedString(record, "format", 64);
  if (format !== "nuriteo-support-bundle-v1+json") throw new TypeError("invalid support bundle format");
  const maximumBytes = record.maximumBytes;
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes !== 65_536) {
    throw new TypeError("invalid support bundle size");
  }
  const readItems = (key: "includes" | "excludes"): string[] =>
    readBoundedArray(record, key, 10).map((item) => {
      const projected = { item };
      return readBoundedString(projected, "item", 256);
    });
  const includes = readItems("includes");
  const excludes = readItems("excludes");
  if (includes.length === 0 || excludes.length === 0) throw new TypeError("invalid support bundle contents");
  return { format, maximumBytes, includes, excludes };
}

function parseDependencies(value: unknown): AdminDependencyStatus {
  const record = readExactRecord(value, ["category", "state"]);
  const state = readEnum(record, "state", STATES);
  const category = record.category === null
    ? null
    : readEnum(record, "category", DEPENDENCY_CATEGORIES);
  if ((state === "nominal") !== (category === null)) {
    throw new TypeError("invalid dependency state");
  }
  return { state, category };
}

function parseCleanup(value: unknown): AdminCleanupQueue {
  const record = readExactRecord(value, [
    "failedCount",
    "oldestEligibleAgeSeconds",
    "queueDepth",
    "retryCount",
    "runningCount",
    "state"
  ]);
  const state = readEnum(record, "state", STATES);
  const result = {
    state,
    queueDepth: nullableCount(record.queueDepth),
    oldestEligibleAgeSeconds: nullableCount(record.oldestEligibleAgeSeconds),
    runningCount: nullableCount(record.runningCount),
    retryCount: nullableCount(record.retryCount),
    failedCount: nullableCount(record.failedCount)
  };
  const counts = [
    result.queueDepth,
    result.runningCount,
    result.retryCount,
    result.failedCount
  ];
  if (state === "unavailable" ? counts.some((count) => count !== null) : counts.some((count) => count === null)) {
    throw new TypeError("invalid cleanup availability");
  }
  return result;
}

function parseUsage(value: unknown): AdminUsage {
  const record = readExactRecord(value, [
    "activeOrganizations",
    "activeProjects",
    "activeUsers",
    "reservedBytes",
    "state",
    "trackedPhysicalBytes",
    "verifiedBundles"
  ]);
  const state = readEnum(record, "state", STATES);
  const result = {
    state,
    activeUsers: nullableCount(record.activeUsers),
    activeOrganizations: nullableCount(record.activeOrganizations),
    activeProjects: nullableCount(record.activeProjects),
    verifiedBundles: nullableCount(record.verifiedBundles),
    trackedPhysicalBytes: nullableDecimal(record.trackedPhysicalBytes),
    reservedBytes: nullableDecimal(record.reservedBytes)
  };
  const values = [
    result.activeUsers,
    result.activeOrganizations,
    result.activeProjects,
    result.verifiedBundles,
    result.trackedPhysicalBytes,
    result.reservedBytes
  ];
  if (state === "unavailable" ? values.some((item) => item !== null) : values.some((item) => item === null)) {
    throw new TypeError("invalid usage availability");
  }
  return result;
}

function nullableCount(value: unknown): number | null {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError("invalid count");
  }
  return value as number;
}

function nullableDecimal(value: unknown): string | null {
  if (value === null) return null;
  const record = { value };
  const parsed = readBoundedString(record, "value", 20);
  if (!/^(?:0|[1-9]\d{0,19})$/u.test(parsed)) {
    throw new TypeError("invalid decimal");
  }
  return parsed;
}
