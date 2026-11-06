import type { Project } from "@nuriteo/api-client";

import type { StudioConsoleEntry } from "@/projects/studio/_utils/preview-console.ts";
import type { RuntimeRecoveryActionKind } from "#src/runtime/runtime-adapter.ts";

export function workbenchLayoutClass({ focusMode, previewOpen, sidebarOpen }: Readonly<{
  focusMode: boolean;
  previewOpen: boolean;
  sidebarOpen: boolean;
}>): string | undefined {
  if (focusMode) {
    return "grid-cols-[minmax(0,1fr)]";
  }
  if (!sidebarOpen && !previewOpen) {
    return "grid-cols-[3rem_minmax(24rem,1fr)] max-[48rem]:grid-cols-[3rem_minmax(0,1fr)]";
  }
  if (!sidebarOpen) {
    return "grid-cols-[3rem_minmax(24rem,1fr)_var(--studio-preview-width)] max-[72rem]:grid-cols-[3rem_minmax(0,1fr)] max-[48rem]:grid-cols-[3rem_minmax(0,1fr)]";
  }
  if (!previewOpen) {
    return "grid-cols-[3rem_var(--studio-sidebar-width)_minmax(24rem,1fr)] max-[72rem]:grid-cols-[3rem_14rem_minmax(0,1fr)] max-[48rem]:grid-cols-[3rem_minmax(0,1fr)]";
  }
  return undefined;
}

export function previewConsoleTone(level: StudioConsoleEntry["level"]): string {
  if (level === "error") return "text-[var(--n-color-studio-danger)]";
  if (level === "warn") return "text-[var(--n-color-studio-warning)]";
  if (level === "info") return "text-[var(--n-color-studio-syntax-symbol)]";
  if (level === "debug") return "text-white/45";
  return "text-white/80";
}

export function projectTemplateLabel(templateId: Project["templateId"]): string {
  return templateId === "next-app" ? "Next.js" : "Vite + React";
}

export function runtimeLifecycleLabel(value: string): string {
  const labels: Readonly<Record<string, string>> = {
    idle: "대기",
    booting: "시작 중",
    ready: "준비됨",
    stopping: "종료 중",
    stopped: "종료됨",
    failed: "오류"
  };
  return labels[value] ?? value;
}

export function serverSavePhaseLabel(value: string): string {
  const labels: Readonly<Record<string, string>> = {
    planning: "저장 계획 수립 중",
    creating: "저장본 생성 중",
    uploading: "업로드 중",
    committing: "서버에 반영 중",
    reconciling: "처리 결과 확인 중"
  };
  return labels[value] ?? value;
}

export function recoveryActionLabel(kind: RuntimeRecoveryActionKind): string {
  if (kind === "clear-cache") return "패키지 캐시 비우기";
  if (kind === "reset-runtime") return "런타임 초기화";
  if (kind === "resolve-writer-conflict") return "편집 권한 가져오기";
  if (kind === "restart-dev-server") return "개발 서버 다시 시작";
  return "미리보기 다시 시도";
}

export function runtimeErrorCode(value: unknown): string | null {
  if (!value || typeof value !== "object" || !("code" in value)) return null;
  const code = (value as { code?: unknown }).code;
  return typeof code === "string" && /^RUNTIME_[A-Z0-9_]{1,56}$/u.test(code) ? code : null;
}

export function projectContentErrorCode(value: unknown): string | null {
  if (!value || typeof value !== "object" || !("code" in value)) return null;
  const code = (value as { code?: unknown }).code;
  return typeof code === "string" && /^RESUME_[A-Z_]{1,48}$/u.test(code) ? code : null;
}

export function resumeErrorMessage(code: string): string {
  if (code === "RESUME_AUTHENTICATION_REQUIRED") {
    return "세션이 만료되었습니다. 다시 로그인한 뒤 프로젝트를 여세요. 로컬 초안은 교체하지 않았습니다.";
  }
  if (code === "RESUME_NOT_SAVED") {
    return "이 프로젝트에는 현재 서버 저장본이 없습니다. 템플릿에서 시작해 첫 로컬 초안을 만드세요.";
  }
  if (code === "RESUME_CONTENT_UNAVAILABLE") {
    return "현재 서버 저장본을 이 계정에서 더 이상 사용할 수 없습니다. 로컬 초안은 교체하지 않았습니다.";
  }
  if (code === "RESUME_LIMIT_EXCEEDED") {
    return "현재 서버 저장본이 브라우저 워크스페이스 제한을 초과합니다. 어떤 파일도 열지 않았습니다.";
  }
  if (code === "RESUME_INTEGRITY_FAILED") {
    return "현재 서버 저장본의 무결성 검증에 실패했습니다. 파일은 열지 않았으므로 다시 시도하거나 관리자에게 저장소 점검을 요청하세요.";
  }
  if (code === "RESUME_ABORTED") return "프로젝트 열기를 취소했습니다. 로컬 초안은 교체하지 않았습니다.";
  return "현재 서버 저장본을 열지 못했습니다. 로컬 초안은 교체하지 않았으므로 서비스가 준비되면 다시 시도하세요.";
}
