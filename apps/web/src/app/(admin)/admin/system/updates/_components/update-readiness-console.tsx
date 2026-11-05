"use client";

import Link from "next/link";

import { AdminPageHeader } from "@/app/(admin)/admin/_components/admin-page-header.tsx";
import { AdminNote, AdminPage, AdminSection, AdminSectionHeading, AdminSummary } from "@/app/(admin)/admin/_components/admin-surface.tsx";
import { useUpdateApprovalHistory, useUpdateReadinessConsole } from "@/app/(admin)/admin/system/updates/_hooks/use-update-readiness-console.ts";
import type { AdminUpdateHistory, AdminUpdateReadiness } from "@/app/(admin)/admin/system/updates/_utils/update-model.ts";
import { buttonVariants } from "@/components/ui/button.styles.ts";
import { Button } from "@/components/ui/button.tsx";
import { CheckboxField } from "@/components/ui/checkbox.tsx";

export function UpdateReadinessConsole({
  readiness
}: {
  readonly readiness: AdminUpdateReadiness;
}) {
  const { acknowledged, approve, error, mutation, notice, setAcknowledged } = useUpdateReadinessConsole(readiness);

  return (
    <AdminPage id="main-content" contentWidth="standard">
      <AdminPageHeader
        category="시스템"
        title="버전 관리"
        description="민감 정보를 제거한 호환성 및 사전 점검 보고서를 검토하세요. 승인은 배포 작업에 운영자의 의도만 기록하며 업데이트를 시작하지 않습니다."
        aside={<div className="flex flex-wrap items-center gap-2"><AdminSummary>
          <span className="shrink-0 rounded-full border border-success px-3 py-1 text-xs font-medium text-foreground data-[state=degraded]:border-warning" data-state={readiness.state === "ready" ? "nominal" : "degraded"}>{readiness.state === "ready" ? "승인 가능" : (function () {
    if (readiness.state === "current") {
        return ("최신 상태");
    }
    return ("차단됨");
})()}</span>
          <time dateTime={readiness.generatedAt}>{formatTimestamp(readiness.generatedAt)}</time>
        </AdminSummary><Link className={buttonVariants({ size: "sm", variant: "secondary" })} href="/admin/system/updates/history">승인 이력</Link></div>}
      />

      <div className="grid grid-cols-2 gap-4 max-[48rem]:grid-cols-1">
        <AdminSection className="min-w-0" aria-labelledby="update-target-title">
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
        </AdminSection>

        <AdminSection className="min-w-0" aria-labelledby="update-preflight-title">
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
        </AdminSection>
      </div>

      {readiness.blockers.length > 0 ? (
        <AdminSection className="border-warning [&_ul]:m-0 [&_ul]:list-none [&_ul]:border-t [&_ul]:border-muted-border [&_ul]:p-0 [&_li]:flex [&_li]:items-start [&_li]:justify-between [&_li]:gap-4 [&_li]:border-b [&_li]:border-muted-border [&_li]:px-4 [&_li]:py-3 [&_li:last-child]:border-b-0 max-[37.5rem]:[&_li]:flex-col max-[37.5rem]:[&_li]:items-stretch [&_li>span]:text-xs [&_li>span]:text-muted-foreground" aria-labelledby="update-blockers-title">
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
        </AdminSection>
      ) : null}

      <AdminSection aria-labelledby="update-approval-title">
        <AdminSectionHeading>
          <div>
            <p className="m-0 mb-3 text-xs font-semibold uppercase tracking-[0.08em] text-accent-foreground">관리자 명시적 실행</p>
            <h2 id="update-approval-title">업데이트 승인</h2>
          </div>
        </AdminSectionHeading>
        {readiness.approvalAllowed ? (
          <div className="flex items-center justify-between gap-4 border-t border-muted-border px-4 py-3 max-[37.5rem]:flex-col max-[37.5rem]:items-stretch [&_label]:flex [&_label]:max-w-[42rem] [&_label]:items-start [&_label]:gap-2 [&_label]:text-sm" aria-busy={mutation.isPending}>
            <CheckboxField checked={acknowledged} disabled={mutation.isPending} onCheckedChange={setAcknowledged} label="차단 요인을 검토했으며 이 작업이 승인만 기록하고 업데이트를 실행하지 않음을 이해했습니다." />
            <Button type="button" disabled={!acknowledged || mutation.isPending} onClick={approve}>
              {(function () {
    if (mutation.isPending) {
        return ("승인 기록 중…");
    }
    return ("업데이트 승인 기록");
})()}
            </Button>
          </div>
        ) : (
          <AdminNote>
            {(function () {
    if (readiness.state === "current") {
        return ("이 인스턴스는 이미 최신 스키마를 사용 중이므로 승인이 필요하지 않습니다.");
    }
    return ("사전 점검 차단 요인이 남아 있는 동안에는 승인할 수 없습니다.");
})()}
          </AdminNote>
        )}
        {notice ? <p role="status" className="m-0 border-t border-muted-border px-5 py-3">{notice}</p> : null}
        {error ? <p role="alert" className="m-0 border-t border-danger px-5 py-3 text-danger">{error}</p> : null}
      </AdminSection>

    </AdminPage>
  );
}

export function UpdateApprovalHistory({ history }: { readonly history: AdminUpdateHistory }) {
  const { loading, nextPage, page, pageError, pageIndex, pages, previousPage } = useUpdateApprovalHistory(history);

  return (
    <AdminPage id="main-content" contentWidth="standard">
      <Link className="inline-flex w-fit items-center gap-2 text-xs font-medium text-muted-foreground hover:text-foreground" href="/admin/system/updates"><span aria-hidden="true">←</span>버전 관리</Link>
      <AdminPageHeader category="시스템" title="업데이트 승인 이력" description="관리자가 검토 후 승인 의도를 남긴 기록만 확인합니다. 이 기록 자체는 업데이트를 실행하지 않습니다." aside={<span className="text-sm text-muted-foreground">{pageIndex + 1}페이지</span>} />
      <AdminSection className="overflow-hidden" aria-labelledby="update-history-title">
        <AdminSectionHeading><div><p className="m-0 mb-3 text-xs font-semibold uppercase tracking-[0.08em] text-accent-foreground">감사 기록</p><h2 id="update-history-title">승인 기록</h2></div></AdminSectionHeading>
        {pageError ? <p className="m-0 border-t border-danger px-4 py-3 text-sm text-danger" role="alert">{pageError}</p> : null}
        {page.items.length === 0 ? <AdminNote>기록된 업데이트 승인이 없습니다.</AdminNote> : <div className="overflow-x-auto border-t border-muted-border"><table className="w-full min-w-[40rem] table-fixed border-collapse text-left"><colgroup><col className="w-[34%]" /><col className="w-[28%]" /><col className="w-[16%]" /><col className="w-[22%]" /></colgroup><thead className="bg-subtle/70 text-xs text-muted-foreground [&_th]:border-b [&_th]:border-muted-border [&_th]:px-4 [&_th]:py-2.5"><tr><th scope="col">대상 릴리스</th><th scope="col">작업</th><th scope="col">결과</th><th scope="col">승인 시각</th></tr></thead><tbody>{page.items.map((item) => <tr className="[&>td]:border-b [&>td]:border-muted-border [&>td]:px-4 [&>td]:py-3 last:[&>td]:border-b-0" key={item.id}><td className="font-semibold">{item.targetRelease}</td><td className="text-sm">업데이트 승인 기록</td><td><span className="text-sm text-success">기록됨</span></td><td><time className="whitespace-nowrap text-xs text-muted-foreground" dateTime={item.occurredAt}>{formatTimestamp(item.occurredAt)}</time></td></tr>)}</tbody></table></div>}
        <footer className="flex items-center justify-between gap-4 border-t border-muted-border px-4 py-3 max-[37.5rem]:flex-col max-[37.5rem]:items-stretch"><span className="text-xs text-muted-foreground">{pageIndex + 1}페이지 · 현재 {page.items.length}건</span><nav className="flex justify-end gap-2 max-[37.5rem]:[&_[data-slot=button]]:flex-1" aria-label="업데이트 승인 이력 페이지 이동"><Button size="sm" disabled={pageIndex === 0 || loading} onClick={previousPage}>이전</Button><Button size="sm" variant="primary" disabled={(pageIndex >= pages.length - 1 && page.nextCursor === null) || loading} onClick={() => void nextPage()}>{loading ? "불러오는 중…" : "다음"}</Button></nav></footer>
      </AdminSection>
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
    timeZone: "Asia/Seoul"
  }).format(new Date(value)) + " KST";
}


