import type { GitConnection } from "@nuriteo/api-client";

import { ApiError } from "@/services/http/api.ts";

export function connectionEtag(connection: GitConnection): string {
  return `"git-connection-v${connection.connectionVersion}"`;
}

export function takeSecret(form: HTMLFormElement, name: string): string {
  const field = form.elements.namedItem(name);
  if (!(field instanceof HTMLInputElement)) return "";
  const value = field.value;
  field.value = "";
  return value;
}

export function gitFailureMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 412) return "원격 저장소가 변경되었습니다. 강제 반영은 시도하지 않았으므로 Git 상태를 새로고침한 뒤 다시 시도하세요.";
    if (error.code === "COMMIT_OUTCOME_UNKNOWN") return "원격 반영 결과를 확인할 수 없습니다. 다시 시도하기 전에 원격 상태를 확인하세요.";
    if (error.code === "REAUTHENTICATION_REQUIRED") return "최근 인증을 갱신하려면 다시 로그인한 뒤 자격 증명 변경을 시도하세요.";
    if (error.status === 401 || error.status === 403) return "현재 세션 또는 프로젝트 권한으로 이 Git 작업을 수행할 수 없습니다.";
    if (error.status === 413) return "Git 전송 크기가 설정된 제한을 초과했습니다.";
  }
  return "Git 작업을 안전하게 완료하지 못했습니다. 자격 증명 정보는 노출되지 않았습니다.";
}
