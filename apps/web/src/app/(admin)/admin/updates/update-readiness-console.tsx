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
import { AdminNote, AdminPage, AdminSectionHeading, AdminSummary } from "#src/app/(admin)/admin/_components/admin-surface.tsx";
import type { AdminUpdateHistory, AdminUpdateReadiness } from "#src/app/(admin)/admin/updates/update-model.ts";

export function UpdateReadinessConsole({
  readiness,
  history
}: {
  readonly readiness: AdminUpdateReadiness;
  readonly history: AdminUpdateHistory;
}) {
  const router = useRouter();
  const mutation = useExclusiveMutation();
  const [acknowledged, setAcknowledged] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();

  async function approve() {
    await mutation.run(async () => {
      setError(undefined);
      setNotice(undefined);
      try {
        await createBrowserApiClient().post(
          "/admin/updates/approval",
          { targetRelease: readiness.targetRelease, acknowledged: true },
          { headers: { "x-csrf-token": readCsrfCredential() } }
        );
        setAcknowledged(false);
        setNotice("업데이트 승인을 기록했습니다. 업데이트는 시작하지 않았습니다.");
        router.refresh();
      } catch (cause) {
        setError(approvalError(cause));
      }
    });
  }

  return (
    <AdminPage id="main-content">
      <AdminPageHeader
        category="업데이트"
        title="버전 관리"
        description="민감 정보를 제거한 호환성 및 사전 점검 보고서를 검토하세요. 승인은 배포 작업에 운영자의 의도만 기록하며 업데이트를 시작하지 않습니다."
        aside={<AdminSummary>
          <span className="shrink-0 rounded-full border border-success px-3 py-1 text-xs font-medium text-foreground data-[state=degraded]:border-warning" data-state={readiness.state === "ready" ? "nominal" : "degraded"}>
            {readiness.state === "ready" ? "승인 가능" : readiness.state === "current" ? "최신 상태" : "차단됨"}
          </span>
          <time dateTime={readiness.generatedAt}>{formatTimestamp(readiness.generatedAt)}</time>
        </AdminSummary>}
      />

      <div className="mt-8 grid grid-cols-2 gap-4 max-[37.5rem]:grid-cols-1">
        <section className="min-w-0 overflow-hidden rounded-xl border border-muted-border bg-surface shadow-xs" aria-labelledby="update-target-title">
          <AdminSectionHeading>
            <div>
              <p className="m-0 mb-3 text-xs font-semibold uppercase tracking-[0.08em] text-accent-foreground">릴리스 경로</p>
              <h2 id="update-target-title">호환성</h2>
            </div>
          </AdminSectionHeading>
          <dl className="m-0 grid border-t border-muted-border [&>div]:grid [&>div]:grid-cols-[minmax(8rem,0.45fr)_minmax(0,1fr)] [&>div]:gap-4 [&>div]:border-b [&>div]:border-muted-border [&>div]:px-5 [&>div]:py-3 max-[37.5rem]:[&>div]:grid-cols-1 max-[37.5rem]:[&>div]:gap-1 [&_dd]:m-0 [&_dd]:text-sm [&_dd]:[overflow-wrap:anywhere] [&_dt]:m-0 [&_dt]:text-xs [&_dt]:text-subtle-foreground [&_dt]:[overflow-wrap:anywhere]">
            <Detail label="설치된 릴리스" value={readiness.currentRelease} />
            <Detail label="대상 릴리스" value={readiness.targetRelease} />
            <Detail label="스키마" value={readiness.compatibility.schemaPolicy} />
            <Detail label="저장 오브젝트" value={readiness.compatibility.objectPolicy} />
            <Detail label="이미지" value={readiness.compatibility.imagePolicy} />
            <Detail label="실패 정책" value={readiness.compatibility.failurePolicy} />
          </dl>
          <AdminNote>
            이미지 다이제스트, 스토리지 엔드포인트, 자격 증명과 백엔드 오류는 의도적으로 표시하지 않습니다.
          </AdminNote>
        </section>

        <section className="min-w-0 overflow-hidden rounded-xl border border-muted-border bg-surface shadow-xs" aria-labelledby="update-preflight-title">
          <AdminSectionHeading>
            <div>
              <p className="m-0 mb-3 text-xs font-semibold uppercase tracking-[0.08em] text-accent-foreground">읽기 전용 점검</p>
              <h2 id="update-preflight-title">사전 점검</h2>
            </div>
            <span className="shrink-0 rounded-full border border-success px-3 py-1 text-xs font-medium text-foreground data-[state=degraded]:border-warning" data-state={readiness.preflight.state === "passed" ? "nominal" : "degraded"}>
              {readiness.preflight.state === "passed" ? "통과" : "중지됨"}
            </span>
          </AdminSectionHeading>
          <dl className="m-0 grid border-t border-muted-border [&>div]:grid [&>div]:grid-cols-[minmax(8rem,0.45fr)_minmax(0,1fr)] [&>div]:gap-4 [&>div]:border-b [&>div]:border-muted-border [&>div]:px-5 [&>div]:py-3 max-[37.5rem]:[&>div]:grid-cols-1 max-[37.5rem]:[&>div]:gap-1 [&_dd]:m-0 [&_dd]:text-sm [&_dd]:[overflow-wrap:anywhere] [&_dt]:m-0 [&_dt]:text-xs [&_dt]:text-subtle-foreground [&_dt]:[overflow-wrap:anywhere]">
            <Detail label="스키마 상태" value={readiness.preflight.schemaState ?? "확인 불가"} />
            <Detail label="현재 마이그레이션" value={formatMigration(readiness.preflight.currentMigration)} />
            <Detail label="대상 마이그레이션" value={formatMigration(readiness.preflight.targetMigration)} />
            <Detail label="설정 레지스트리" value={`v${readiness.compatibility.configurationRegistryVersion}`} />
          </dl>
          <AdminNote>
            배포 도구는 변경 전에 활성 이미지 세트와 오브젝트 스토리지를 다시 확인해야 합니다.
          </AdminNote>
        </section>
      </div>

      {readiness.blockers.length > 0 ? (
        <section className="mt-6 overflow-hidden rounded-xl border border-warning bg-surface shadow-xs [&_ul]:m-0 [&_ul]:list-none [&_ul]:border-t [&_ul]:border-muted-border [&_ul]:p-0 [&_li]:flex [&_li]:items-start [&_li]:justify-between [&_li]:gap-4 [&_li]:border-b [&_li]:border-muted-border [&_li]:px-5 [&_li]:py-4 [&_li:last-child]:border-b-0 max-[37.5rem]:[&_li]:flex-col max-[37.5rem]:[&_li]:items-stretch [&_li>span]:text-xs [&_li>span]:text-muted-foreground" aria-labelledby="update-blockers-title">
          <AdminSectionHeading>
            <div>
              <p className="m-0 mb-3 text-xs font-semibold uppercase tracking-[0.08em] text-accent-foreground">업그레이드 중단 조건</p>
              <h2 id="update-blockers-title">승인 전 차단 요인을 해결하세요</h2>
            </div>
          </AdminSectionHeading>
          <ul>
            {readiness.blockers.map((blocker) => (
              <li key={blocker.code}>
                <strong>{blocker.summary}</strong>
                <span>{blocker.operatorAction}</span>
                <code>{blocker.code}</code>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="mt-6 overflow-hidden rounded-xl border border-muted-border bg-surface shadow-xs" aria-labelledby="update-approval-title">
        <AdminSectionHeading>
          <div>
            <p className="m-0 mb-3 text-xs font-semibold uppercase tracking-[0.08em] text-accent-foreground">관리자 명시적 실행</p>
            <h2 id="update-approval-title">업데이트 승인</h2>
          </div>
        </AdminSectionHeading>
        {readiness.approvalAllowed ? (
          <div className="flex items-center justify-between gap-4 border-t border-muted-border px-5 py-4 max-[37.5rem]:flex-col max-[37.5rem]:items-stretch [&_label]:flex [&_label]:max-w-[42rem] [&_label]:items-start [&_label]:gap-2 [&_label]:text-sm" aria-busy={mutation.isPending}>
            <CheckboxField checked={acknowledged} disabled={mutation.isPending} onCheckedChange={setAcknowledged} label="차단 요인을 검토했으며 이 작업이 승인만 기록하고 업데이트를 실행하지 않음을 이해했습니다." />
            <Button type="button" disabled={!acknowledged || mutation.isPending} onClick={approve}>
              {mutation.isPending ? "승인 기록 중…" : "업데이트 승인 기록"}
            </Button>
          </div>
        ) : (
          <AdminNote>
            {readiness.state === "current"
              ? "이 인스턴스는 이미 최신 스키마를 사용 중이므로 승인이 필요하지 않습니다."
              : "사전 점검 차단 요인이 남아 있는 동안에는 승인할 수 없습니다."}
          </AdminNote>
        )}
        {notice ? <p role="status" className="m-0 border-t border-muted-border px-5 py-3">{notice}</p> : null}
        {error ? <p role="alert" className="m-0 border-t border-danger px-5 py-3 text-danger">{error}</p> : null}
      </section>

      <section className="mt-6 overflow-hidden rounded-xl border border-muted-border bg-surface shadow-xs [&_ol]:m-0 [&_ol]:list-none [&_ol]:border-t [&_ol]:border-muted-border [&_ol]:p-0 [&_li]:flex [&_li]:items-start [&_li]:justify-between [&_li]:gap-4 [&_li]:border-b [&_li]:border-muted-border [&_li]:px-5 [&_li]:py-4 [&_li:last-child]:border-b-0 max-[37.5rem]:[&_li]:flex-col max-[37.5rem]:[&_li]:items-stretch [&_li>div]:grid [&_li>div]:gap-1 [&_li_span]:text-xs [&_li_span]:text-muted-foreground [&_time]:shrink-0 [&_time]:text-xs [&_time]:text-muted-foreground" aria-labelledby="update-history-title">
        <AdminSectionHeading>
          <div>
            <p className="m-0 mb-3 text-xs font-semibold uppercase tracking-[0.08em] text-accent-foreground">감사 기록</p>
            <h2 id="update-history-title">최근 업데이트 승인</h2>
          </div>
        </AdminSectionHeading>
        {history.items.length === 0 ? (
          <AdminNote>기록된 업데이트 승인이 없습니다.</AdminNote>
        ) : (
          <ol>
            {history.items.map((item) => (
              <li key={item.id}>
                <div>
                  <strong>{item.targetRelease}</strong>
                  <span>승인만 기록했으며 이 작업으로 업데이트를 시작하지 않았습니다.</span>
                </div>
                <time dateTime={item.occurredAt}>{formatTimestamp(item.occurredAt)}</time>
              </li>
            ))}
          </ol>
        )}
      </section>
    </AdminPage>
  );
}

function Detail({ label, value }: { readonly label: string; readonly value: string }) {
  return <div><dt>{label}</dt><dd>{value}</dd></div>;
}

function formatMigration(value: number | null): string {
  return value === null ? "—" : String(value);
}

function formatTimestamp(value: string): string {
  return new Intl.DateTimeFormat("ko-KR", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC"
  }).format(new Date(value)) + " UTC";
}

function approvalError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === "REAUTHENTICATION_REQUIRED" || error.status === 403) {
      return "승인하려면 최근 관리자 재인증이 필요합니다.";
    }
    if (error.status === 409) {
      return "준비 상태가 변경되어 승인을 기록하지 않았습니다. 최신 차단 요인을 검토하세요.";
    }
    if (error.code === "COMMIT_OUTCOME_UNKNOWN") {
      return "승인 결과를 확인할 수 없습니다. 기록을 새로 불러온 뒤 다시 시도하세요.";
    }
  }
  return "승인을 기록하지 못했습니다. 업데이트는 시작되지 않았습니다.";
}
