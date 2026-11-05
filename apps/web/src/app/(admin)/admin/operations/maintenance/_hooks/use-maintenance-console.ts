"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import type { AdminMaintenanceStatus } from "@/app/(admin)/admin/operations/maintenance/_utils/maintenance-model.ts";
import { createBrowserApiClient } from "@/lib/api/browser-client.ts";
import { readCsrfCredential } from "@/lib/api/browser-security.ts";
import { useExclusiveMutation } from "@/lib/use-exclusive-mutation.ts";
import { ApiError } from "@/services/http/api.ts";

type Feedback = { readonly error: boolean; readonly text: string };

export function useMaintenanceConsole(initial: AdminMaintenanceStatus) {
  const router = useRouter();
  const mutation = useExclusiveMutation();
  const [status, setStatus] = useState(initial);
  const [confirmed, setConfirmed] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>();

  async function update(nextEnabled: boolean) {
    await mutation.run(async () => {
      setFeedback(undefined);
      try {
        const response = await createBrowserApiClient().put<AdminMaintenanceStatus>(
          "/admin/maintenance",
          { enabled: nextEnabled },
          { headers: { "x-csrf-token": readCsrfCredential() }, timeoutMs: 35_000 }
        );
        setStatus(response.data);
        setConfirmed(false);
        setFeedback({
          error: false,
          text: nextEnabled
            ? "유지보수 모드가 활성화되었습니다. 기존 쓰기가 종료된 뒤 쓰기 경계를 닫았습니다."
            : "유지보수 모드를 종료했습니다. 새 쓰기를 다시 허용합니다."
        });
        router.refresh();
      } catch (error) {
        setFeedback({ error: true, text: maintenanceError(error) });
      }
    });
  }

  return { confirmed, feedback, mutation, setConfirmed, status, update };
}

function maintenanceError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === "REAUTHENTICATION_REQUIRED") return "보안을 위해 다시 로그인한 뒤 유지보수 변경을 다시 시도하세요.";
    if (error.status === 403) return "이 유지보수 변경을 수행할 관리자 권한이 없습니다.";
    if (error.status === 504) return "제한 시간 안에 활성 쓰기가 종료되지 않았습니다. 인스턴스는 안전을 위해 차단 상태를 유지합니다. 계속하기 전에 상태를 새로 불러오세요.";
    if (error.code === "COMMIT_OUTCOME_UNKNOWN") return "제어 결과를 확인할 수 없습니다. 현재 상태를 새로 불러온 뒤 다시 시도하세요.";
  }
  return "유지보수 모드를 변경하지 못했습니다. 현재 상태를 새로 불러온 뒤 다시 시도하세요.";
}
