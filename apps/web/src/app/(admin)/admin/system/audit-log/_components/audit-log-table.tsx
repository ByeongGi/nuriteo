"use client";

import { tv } from "tailwind-variants";

import { AdminPageHeader } from "@/app/(admin)/admin/_components/admin-page-header.tsx";
import { AdminCollectionHeading, AdminPage, AdminPanel } from "@/app/(admin)/admin/_components/admin-surface.tsx";
import { AUDIT_PAGE_SIZE, useAuditLogTable } from "@/app/(admin)/admin/system/audit-log/_hooks/use-audit-log-table.ts";
import type { AuditEventPage } from "@/app/(admin)/admin/system/audit-log/_utils/audit-log-model.ts";
import { Badge } from "@/components/ui/badge.tsx";
import { Button } from "@/components/ui/button.tsx";

const styles = tv({
  slots: {
    tableViewport: "overflow-x-auto border-t border-muted-border",
    table: "w-full min-w-[52rem] table-fixed border-collapse text-left",
    head: "bg-subtle/70 text-xs font-semibold text-muted-foreground [&_th]:border-b [&_th]:border-muted-border [&_th]:px-4 [&_th]:py-2.5",
    row: "hover:bg-hover [&>td]:border-b [&>td]:border-muted-border [&>td]:px-4 [&>td]:py-3 [&>td]:align-middle last:[&>td]:border-b-0",
    primary: "grid min-w-0 gap-1",
    title: "truncate text-sm font-semibold text-foreground",
    mono: "truncate font-mono text-xs text-muted-foreground",
    time: "whitespace-nowrap text-xs text-muted-foreground",
    empty: "m-0 px-5 py-16 text-center text-sm text-muted-foreground",
    footer: "flex items-center justify-between gap-4 border-t border-muted-border px-4 py-3 max-[37.5rem]:flex-col max-[37.5rem]:items-stretch",
    pageState: "text-xs text-muted-foreground",
    pagination: "flex items-center justify-end gap-2 max-[37.5rem]:[&_[data-slot=button]]:flex-1"
  }
});

export function AuditLogTable({ initialPage }: { readonly initialPage: AuditEventPage }) {
  const { hasNext, hasPrevious, nextPage, page, pageIndex, previousPage, query } = useAuditLogTable(initialPage);
  const css = styles();

  return (
    <AdminPage id="main-content" contentWidth="wide" tabIndex={-1}>
      <AdminPageHeader category="시스템" title="감사 로그" description="관리자와 시스템의 주요 변경 이력을 최신 순서로 확인합니다. 데이터는 25건씩 안전하게 조회합니다." />
      <AdminPanel className="overflow-hidden p-0" aria-labelledby="audit-events-title">
        <AdminCollectionHeading className="mb-0 px-4 py-3"><div><h2 id="audit-events-title">이벤트</h2><p className="m-0 mt-1 text-xs text-muted-foreground">작업, 행위자와 변경 대상을 같은 행에서 비교할 수 있습니다.</p></div><Badge>{pageIndex + 1}페이지</Badge></AdminCollectionHeading>
        {query.isFetchNextPageError ? <p className="m-0 border-t border-danger px-5 py-3 text-sm text-danger" role="alert">다음 페이지를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.</p> : null}
        {page.items.length === 0 ? <p className={css.empty()}>표시할 감사 이벤트가 없습니다.</p> : (
          <div className={css.tableViewport()}>
            <table className={css.table()}>
              <colgroup><col className="w-[26%]" /><col className="w-[22%]" /><col className="w-[26%]" /><col className="w-[10%]" /><col className="w-[16%]" /></colgroup>
              <thead className={css.head()}><tr><th scope="col">작업</th><th scope="col">행위자</th><th scope="col">대상</th><th scope="col">결과</th><th scope="col">발생 시각</th></tr></thead>
              <tbody>{page.items.map((event) => <tr className={css.row()} key={event.id}>
                <td><div className={css.primary()}><span className={css.title()}>{auditActionLabel(event.actionCode)}</span><span className={css.mono()} title={event.actionCode}>{event.actionCode}</span></div></td>
                <td><div className={css.primary()}><span className={css.title()}>{event.actorDisplayName ?? "시스템"}</span><span className={css.mono()} title={event.actorId}>{event.actorId}</span></div></td>
                <td><div className={css.primary()}><span className={css.title()}>{auditTargetLabel(event.targetType)}</span><span className={css.mono()} title={event.targetId}>{event.targetId}</span></div></td>
                <td><Badge size="sm" tone={(function () {
    if (event.result === "succeeded") {
        return ("success");
    }
    return ("danger");
})()} variant="status">{(function () {
    if (event.result === "succeeded") {
        return ("성공");
    }
    return ("실패");
})()}</Badge></td>
                <td><time className={css.time()} dateTime={event.occurredAt}>{formatDate(event.occurredAt)}</time></td>
              </tr>)}</tbody>
            </table>
          </div>
        )}
        <footer className={css.footer()}>
          <span className={css.pageState()} aria-live="polite">{pageIndex + 1}페이지 · 현재 {page.items.length}건 · 페이지당 최대 {AUDIT_PAGE_SIZE}건</span>
          <nav className={css.pagination()} aria-label="감사 로그 페이지 이동"><Button size="sm" type="button" disabled={!hasPrevious || query.isFetchingNextPage} onClick={previousPage}>이전</Button><Button size="sm" type="button" variant="primary" disabled={!hasNext || query.isFetchingNextPage} onClick={() => void nextPage()}>{query.isFetchingNextPage ? "불러오는 중…" : "다음"}</Button></nav>
        </footer>
      </AdminPanel>
    </AdminPage>
  );
}

function formatDate(value: string): string { const date = new Date(value); return Number.isNaN(date.valueOf()) ? value : new Intl.DateTimeFormat("ko-KR", { dateStyle: "medium", timeStyle: "short" }).format(date); }

function auditActionLabel(actionCode: string): string {
  const labels: Readonly<Record<string, string>> = {
    "auth.login_succeeded": "로그인 성공", "auth.logout": "로그아웃", "instance_admin.bootstrap_created": "최초 관리자 생성",
    "mfa.enrollment_started": "MFA 등록 시작", "organization.created": "조직 생성", "project.created": "프로젝트 생성"
  };
  return labels[actionCode] ?? actionCode;
}

function auditTargetLabel(targetType: string): string {
  const labels: Readonly<Record<string, string>> = { organization: "조직", project: "프로젝트", session: "사용자 세션", user: "사용자" };
  return labels[targetType] ?? targetType;
}
