"use client";

import { ApiError } from "@nuriteo/api-client";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "#src/components/ui/button.tsx";
import { CheckboxField } from "#src/components/ui/checkbox.tsx";
import { createBrowserApiClient } from "#src/lib/api/browser-client.ts";
import { readCsrfCredential } from "#src/lib/api/browser-security.ts";
import { useExclusiveMutation } from "#src/lib/use-exclusive-mutation.ts";
import { AdminPageHeader } from "#src/app/(admin)/admin/_components/admin-page-header.tsx";
import { AdminPage, AdminSectionHeading } from "#src/app/(admin)/admin/_components/admin-surface.tsx";
import type { AdminMaintenanceStatus } from "#src/app/(admin)/admin/maintenance/maintenance-model.ts";

export function MaintenanceConsole({ initial }: { readonly initial: AdminMaintenanceStatus }) {
  const router = useRouter();
  const mutation = useExclusiveMutation();
  const [status, setStatus] = useState(initial);
  const [confirmed, setConfirmed] = useState(false);
  const [feedback, setFeedback] = useState<{ readonly error: boolean; readonly text: string }>();
  const enabled = status.phase !== "active";

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

  return (
    <AdminPage id="main-content">
      <AdminPageHeader
        category="유지보수"
        title="유지보수"
        description="백업 복구나 업데이트 전에 새 쓰기를 안전하게 차단합니다. 기존 쓰기가 종료되는 동안 조회는 계속 사용할 수 있습니다."
        aside={<div className="grid shrink-0 justify-items-end gap-2 text-xs text-subtle-foreground max-[37.5rem]:justify-items-start">
          <span className="shrink-0 rounded-full border border-success px-3 py-1 text-xs font-medium text-foreground data-[state=degraded]:border-warning" data-state={enabled ? "degraded" : "nominal"}>
            {phaseLabel(status.phase)}
          </span>
          <span>활성 쓰기 {status.activeWrites}개</span>
        </div>}
      />

      <section className="mt-4 overflow-hidden rounded-lg border border-muted-border bg-surface" aria-labelledby="maintenance-action-title">
        <AdminSectionHeading>
          <div>
            <p className="m-0 mb-3 text-xs font-semibold uppercase tracking-[0.08em] text-accent-foreground">쓰기 제한 범위</p>
            <h2 id="maintenance-action-title">
              {enabled ? "정상 운영 재개" : "유지보수 모드 시작"}
            </h2>
          </div>
        </AdminSectionHeading>
        <div className="flex items-center justify-between gap-4 border-t border-muted-border px-4 py-3 max-[37.5rem]:flex-col max-[37.5rem]:items-stretch [&_label]:flex [&_label]:max-w-[42rem] [&_label]:items-start [&_label]:gap-2 [&_label]:text-sm" aria-busy={mutation.isPending}>
          <CheckboxField
            checked={confirmed}
            disabled={mutation.isPending}
            onCheckedChange={setConfirmed}
            label={enabled
              ? "유지보수 작업이 끝났으며 새 쓰기를 허용해도 안전함을 확인했습니다."
              : "새 쓰기가 거부되고 활성 쓰기가 먼저 종료되어야 함을 이해했습니다."}
          />
          <Button
            type="button"
            disabled={!confirmed || mutation.isPending}
            onClick={() => void update(!enabled)}
          >
            {mutation.isPending
              ? enabled ? "재개하는 중…" : "활성 쓰기 종료 중…"
              : enabled ? "쓰기 재개" : "유지보수 시작"}
          </Button>
        </div>
        <p className="m-0 border-t border-muted-border px-4 py-3 text-xs text-muted-foreground">
          최근 관리자 재인증이 필요합니다. 종료 제한 시간을 넘기면 안전을 위해 차단 상태를 유지하므로 다시 시도하기 전에 현재 상태를 새로 확인하세요.
        </p>
        {feedback ? (
          <p role={feedback.error ? "alert" : "status"} className={feedback.error ? "m-0 border-t border-danger px-5 py-3 text-danger" : "m-0 border-t border-muted-border px-5 py-3"}>
            {feedback.text}
          </p>
        ) : null}
      </section>
    </AdminPage>
  );
}

function phaseLabel(phase: AdminMaintenanceStatus["phase"]): string {
  if (phase === "active") return "정상 운영";
  if (phase === "draining") return "쓰기 종료 중";
  return "읽기 전용";
}

function maintenanceError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 403) {
      return "이 변경에는 최근 관리자 재인증이 필요합니다.";
    }
    if (error.status === 504) {
      return "제한 시간 안에 활성 쓰기가 종료되지 않았습니다. 인스턴스는 안전을 위해 차단 상태를 유지합니다. 계속하기 전에 상태를 새로 불러오세요.";
    }
    if (error.code === "COMMIT_OUTCOME_UNKNOWN") {
      return "제어 결과를 확인할 수 없습니다. 현재 상태를 새로 불러온 뒤 다시 시도하세요.";
    }
  }
  return "유지보수 모드를 변경하지 못했습니다. 현재 상태를 새로 불러온 뒤 다시 시도하세요.";
}
