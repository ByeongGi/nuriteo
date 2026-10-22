"use client";

import { ApiError } from "@nuriteo/api-client";

import { isCanonicalCsrfCredential } from "#src/lib/api/csrf-credential.ts";

const CSRF_NAMES = ["__Host-nuriteo_csrf", "nuriteo_dev_csrf"] as const;

export type CollaborationOperation =
  | "activation-invitation-issue"
  | "activation-invitation-terminal"
  | "organization-create"
  | "organization-invitation-issue"
  | "organization-invitation-terminal"
  | "organization-member"
  | "organization-profile"
  | "project-create"
  | "project-delete"
  | "project-lifecycle"
  | "project-profile"
  | "project-role";

export interface ProjectFailure {
  readonly message: string;
  readonly reconcile: boolean;
}

export function readCsrfCredential(): string {
  for (const pair of document.cookie.split(";")) {
    const separator = pair.indexOf("=");
    if (separator < 1) continue;
    const name = pair.slice(0, separator).trim();
    if (!CSRF_NAMES.includes(name as (typeof CSRF_NAMES)[number])) continue;
    const value = pair.slice(separator + 1);
    if (isCanonicalCsrfCredential(value)) return value;
  }
  throw new Error("브라우저 보안 자격 증명을 확인할 수 없습니다.");
}

export function collaborationError(
  error: unknown,
  operation: CollaborationOperation
): string {
  if (error instanceof ApiError) {
    if (error.status === 403) return "이 작업을 수행할 권한이 없습니다.";
    if (error.status === 412 || error.status === 428) {
      return "조직 정보가 변경되었습니다. 최신 버전을 불러온 뒤 다시 시도하세요.";
    }
    const terminalValidation = error.status === 422 && error.fieldErrors.some(
      (field) => field.path === "invitation" || field.path === "token"
    );
    if (
      (operation === "activation-invitation-terminal" ||
        operation === "organization-invitation-terminal") &&
      (error.status === 409 || error.status === 410 || terminalValidation)
    ) {
      return "이 초대는 더 이상 사용할 수 없습니다. 만료되었거나 이미 사용·취소·교체되었을 수 있습니다.";
    }
    if (operation === "organization-create" && error.status === 409) {
      return "이미 사용 중인 조직 주소입니다. 다른 주소를 입력하세요.";
    }
    if (operation === "organization-member" && error.status === 409) {
      return "마지막 조직 소유자의 역할은 변경하거나 삭제할 수 없습니다.";
    }
    if (
      operation === "organization-invitation-issue" &&
      (error.status === 404 || error.status === 409)
    ) {
      return "초대를 발급할 수 없습니다. 사용할 수 없는 계정이거나 이미 초대 또는 참여한 계정일 수 있습니다.";
    }
    if (error.status === 400 || error.status === 422) {
      return "입력값이 올바르지 않습니다. 폼을 확인하고 다시 시도하세요.";
    }
  }
  return "요청을 완료하지 못했습니다. 서비스 상태를 확인하고 다시 시도하세요.";
}

export function projectError(error: unknown, operation: CollaborationOperation): ProjectFailure {
  if (error instanceof ApiError) {
    if (error.code === "COMMIT_OUTCOME_UNKNOWN") {
      return {
        message: "서버에서 변경을 완료했을 수 있습니다. 다음 작업 전에 프로젝트를 새로 불러오세요.",
        reconcile: true
      };
    }
    if (error.status === 412 || error.status === 428) {
      return {
        message: "프로젝트 정보가 변경되었습니다. 최신 버전을 불러온 뒤 다시 시도하세요.",
        reconcile: true
      };
    }
    if (error.status === 403) {
      return { message: "이 작업을 수행할 권한이 없습니다.", reconcile: false };
    }
    if (operation === "project-create" && error.status === 409) {
      return { message: "이 워크스페이스에서 이미 사용 중인 프로젝트 주소입니다.", reconcile: false };
    }
    if ((operation === "project-lifecycle" || operation === "project-delete") && error.status === 409) {
      return { message: "현재 프로젝트 상태에서는 이 작업을 수행할 수 없습니다. 새로 불러온 뒤 확인하세요.", reconcile: true };
    }
    if (error.status === 400 || error.status === 422) {
      return { message: "입력값이 올바르지 않습니다. 폼을 확인하고 다시 시도하세요.", reconcile: false };
    }
  }
  return {
    message: "요청을 완료하지 못했습니다. 서비스 상태를 확인하고 다시 시도하세요.",
    reconcile: false
  };
}
