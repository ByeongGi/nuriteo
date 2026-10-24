import { ApiError } from "@nuriteo/api-client";

export function teamErrorMessage(cause: unknown): string {
  if (cause instanceof ApiError) {
    if (cause.status === 403) return "이 팀 작업을 수행할 권한이 없습니다.";
    if (cause.status === 412 || cause.status === 428 || cause.code === "COMMIT_OUTCOME_UNKNOWN") return "팀 정보가 변경되었거나 처리 결과를 확인할 수 없습니다. 최신 정보를 불러온 뒤 다시 시도하세요.";
    if (cause.status === 409) return "이미 사용 중인 값이거나 팀 정보가 변경되었습니다.";
    if (cause.status === 400 || cause.status === 422) return "입력값이 올바르지 않습니다. 내용을 확인해 주세요.";
  }
  return "팀 요청을 완료하지 못했습니다. 서비스 상태를 확인하고 다시 시도하세요.";
}

export function teamMemberEtag(version: number): string { return `"team-member-v${version}"`; }
export function teamProjectRoleEtag(version: number): string { return `"team-project-role-v${version}"`; }
