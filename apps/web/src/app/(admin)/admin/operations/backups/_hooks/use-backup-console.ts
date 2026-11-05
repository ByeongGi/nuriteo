"use client";

import { useState } from "react";

import { backupPolicySchema } from "@/app/(admin)/admin/operations/backups/_schema/backup-policy.ts";
import { createBrowserApiClient } from "@/lib/api/browser-client.ts";
import { readCsrfCredential } from "@/lib/api/browser-security.ts";
import { useExclusiveMutation } from "@/lib/use-exclusive-mutation.ts";
import { enqueueAdminBackupOperation, listAdminBackupOperations, updateAdminBackupPolicy } from "@/services/admin/api.ts";
import { ApiError } from "@/services/http/api.ts";

import type { FormEvent } from "react";
import type { AdminBackupConsole as BackupState, AdminBackupOperationCollection, AdminBackupOperationKind, AdminBackupPolicyUpdate } from "@nuriteo/api-client";

export function useRetentionField(value: number | null) {
  const [lastFiniteValue, setLastFiniteValue] = useState(value ?? 1);
  function changeFinite(nextValue: number, update: (value: number) => void) {
    setLastFiniteValue(nextValue);
    update(nextValue);
  }
  return { changeFinite, lastFiniteValue };
}

export function useBackupConsole(initial: BackupState, initialOperations: AdminBackupOperationCollection) {
  const mutation = useExclusiveMutation();
  const [state, setState] = useState(initial);
  const [draft, setDraft] = useState<AdminBackupPolicyUpdate>(initial.policy);
  const [feedback, setFeedback] = useState<{ readonly error: boolean; readonly text: string }>();
  const [operationPages, setOperationPages] = useState<readonly AdminBackupOperationCollection[]>([initialOperations]);
  const [operationPageIndex, setOperationPageIndex] = useState(0);
  const [operationPageLoading, setOperationPageLoading] = useState(false);
  const operationPage = operationPages[operationPageIndex] ?? initialOperations;

  async function nextOperationPage() {
    if (operationPageIndex < operationPages.length - 1) {
      setOperationPageIndex((current) => current + 1);
      return;
    }
    if (operationPage.nextCursor === null || operationPageLoading) return;
    setOperationPageLoading(true);
    setFeedback(undefined);
    try {
      const result = await listAdminBackupOperations(createBrowserApiClient(), { cursor: operationPage.nextCursor, limit: 25 });
      setOperationPages((current) => [...current, result.data]);
      setOperationPageIndex((current) => current + 1);
    } catch (error) {
      setFeedback({ error: true, text: backupError(error) });
    } finally {
      setOperationPageLoading(false);
    }
  }

  async function savePolicy(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = backupPolicySchema.safeParse(draft);
    if (!parsed.success) {
      setFeedback({ error: true, text: parsed.error.issues[0]?.message ?? "일정, 시간대와 보존 한도를 확인해 주세요." });
      return;
    }
    await mutation.run(async () => {
      setFeedback(undefined);
      try {
        const result = await updateAdminBackupPolicy(createBrowserApiClient(), draft, {
          headers: {
            "if-match": `"backup-policy-v${state.policy.version}"`,
            "x-csrf-token": readCsrfCredential()
          }
        });
        setState(result.data);
        setDraft(result.data.policy);
        setFeedback({ error: false, text: "백업 정책을 저장하고 감사 로그에 기록했습니다." });
      } catch (error) {
        setFeedback({ error: true, text: backupError(error) });
      }
    });
  }

  async function run(kind: AdminBackupOperationKind, backupId: string | null = null) {
    await mutation.run(async () => {
      setFeedback(undefined);
      try {
        const result = await enqueueAdminBackupOperation(
          createBrowserApiClient(),
          { kind, backupId },
          { headers: { "x-csrf-token": readCsrfCredential() } }
        );
        setState(result.data);
        setFeedback({
          error: false,
          text: `${backupActionLabel(kind)} 작업을 대기열에 추가했습니다. 장기 실행 작업은 브라우저 요청이 끝난 뒤에도 계속됩니다.`
        });
      } catch (error) {
        setFeedback({ error: true, text: backupError(error) });
      }
    });
  }

  return {
    draft,
    feedback,
    mutation,
    nextOperationPage,
    operationPage,
    operationPageIndex,
    operationPageLoading,
    operationPages,
    previousOperationPage: () => setOperationPageIndex((current) => Math.max(0, current - 1)),
    run,
    savePolicy,
    setDraft,
    state
  };
}

export function backupActionLabel(kind: AdminBackupOperationKind) {
  return ({ create: "백업 생성", verify: "복구 지점 검증", drill: "복구 훈련", prune: "보존 대상 정리" })[kind];
}

function backupError(error: unknown) {
  if (error instanceof ApiError) {
    if (error.code === "REAUTHENTICATION_REQUIRED") return "보안을 위해 다시 로그인한 뒤 백업 변경을 다시 시도하세요.";
    if (error.status === 403) return "이 백업 변경을 수행할 관리자 권한이 없습니다.";
    if (error.status === 409) return "다른 백업 작업이 이미 대기 중이거나 실행 중입니다.";
    if (error.status === 412) return "다른 곳에서 백업 정책이 변경되었습니다. 페이지를 새로 고친 뒤 다시 시도하세요.";
    if (error.status === 422) return "일정, 시간대와 보존 한도를 확인해 주세요.";
  }
  return "백업 요청을 완료하지 못했습니다. 현재 상태를 새로 고친 뒤 다시 시도하세요.";
}
