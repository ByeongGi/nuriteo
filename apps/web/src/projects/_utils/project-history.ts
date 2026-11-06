import type { ProjectVersion, RecoveryCheckpoint } from "@nuriteo/api-client";

import {
  ApiError,
  ApiInvalidResponseError,
  ApiResponseTooLargeError,
  ApiTimeoutError,
  ApiTransportError
} from "@/services/http/api.ts";

export const VERSION_PAGE_SIZE = 20;

const timestampFormatter = new Intl.DateTimeFormat("ko-KR", {
  dateStyle: "medium",
  timeStyle: "short"
});

export function historyLoadedStatus(versionCount: number, recoveryCount: number): string {
  return `버전 ${versionCount}개와 복구 지점 ${recoveryCount}개를 불러왔습니다.`;
}

export function appendUniqueVersions(first: readonly ProjectVersion[], second: readonly ProjectVersion[]): readonly ProjectVersion[] {
  const seen = new Set<string>();
  return [...first, ...second].filter((item) => seen.has(item.id) ? false : (seen.add(item.id), true));
}

export function sortRecoveryCheckpoints(items: readonly RecoveryCheckpoint[]): readonly RecoveryCheckpoint[] {
  return [...items].sort((left, right) => {
    const instantOrder = Date.parse(right.createdAt) - Date.parse(left.createdAt);
    return instantOrder || right.id.localeCompare(left.id);
  });
}

export function idempotencyKey(action: string): string {
  return `history-${action}-${globalThis.crypto.randomUUID()}`;
}

export function staleProject(cause: unknown): boolean {
  return cause instanceof ApiError && (cause.status === 412 || cause.status === 428);
}

export function outcomeMayBeUnknown(cause: unknown): boolean {
  return cause instanceof ApiTimeoutError ||
    cause instanceof ApiTransportError ||
    cause instanceof ApiInvalidResponseError ||
    cause instanceof ApiResponseTooLargeError ||
    (cause instanceof ApiError && (cause.code === "COMMIT_OUTCOME_UNKNOWN" || cause.code === "RECONCILIATION_REQUIRED"));
}

export function historyFailureMessage(cause: unknown, action: "create" | "read" | "restore"): string {
  if (cause instanceof ApiError) {
    if (cause.status === 412 || cause.status === 428) return "서버 프로젝트가 변경되었습니다. 로컬 초안은 보존되므로 최신 프로젝트를 불러온 뒤 다시 시도하세요.";
    if (cause.status === 403) return "이 기록 작업을 수행할 권한이 없습니다.";
    if (cause.code === "COMMIT_OUTCOME_UNKNOWN" || cause.code === "RECONCILIATION_REQUIRED") return "서버 처리 결과를 아직 확인할 수 없습니다. 로컬 초안은 보존되므로 서비스가 준비되면 결과 확인을 다시 시도하세요.";
  }
  if (action === "read") return "기록을 일시적으로 사용할 수 없습니다. 로컬 초안을 변경하지 않고 다시 시도할 수 있습니다.";
  return `${action === "create" ? "버전 만들기" : "기록 복구"}를 완료하지 못했습니다. 로컬 초안은 보존되므로 같은 작업을 안전하게 다시 시도할 수 있습니다.`;
}

export function formatTimestamp(value: string): string {
  return timestampFormatter.format(new Date(value));
}

export function formatBytes(value: number): string {
  if (value < 1_024) return `${value} B`;
  if (value < 1_048_576) return `${(value / 1_024).toFixed(1)} KiB`;
  return `${(value / 1_048_576).toFixed(1)} MiB`;
}
