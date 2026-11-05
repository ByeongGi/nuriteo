"use client";

import type { EmailDelivery, EmailDeliveryCollection, EmailDeliveryState } from "@nuriteo/api-client";

import { AdminPageHeader } from "@/app/(admin)/admin/_components/admin-page-header.tsx";
import { AdminFeedback, AdminPage, AdminSection } from "@/app/(admin)/admin/_components/admin-surface.tsx";
import { useEmailDeliveryConsole } from "@/app/(admin)/admin/operations/email-deliveries/_hooks/use-email-delivery-console.ts";
import { Badge } from "@/components/ui/badge.tsx";
import { Button } from "@/components/ui/button.tsx";
import { SelectField } from "@/components/ui/field.tsx";

const FILTERS: readonly { readonly value: EmailDeliveryState; readonly label: string }[] = [
  { value: "dead_letter", label: "최종 실패" },
  { value: "retry_wait", label: "재시도 대기" },
  { value: "pending", label: "전송 대기" },
  { value: "sending", label: "전송 중" },
  { value: "sent", label: "전송 완료" },
  { value: "canceled", label: "폐기됨" }
];

export function EmailDeliveryConsole({ initial }: { readonly initial: EmailDeliveryCollection }) {
  const {
    apply,
    cancelConfirmation,
    collection,
    confirmation,
    feedback,
    mutation,
    nextPage,
    pageIndex,
    pages,
    previousPage,
    selectState,
    state
  } = useEmailDeliveryConsole(initial);

  return (
    <AdminPage id="main-content" contentWidth="standard">
      <AdminPageHeader
        category="운영"
        title="이메일 전송"
        description="정제된 전송 메타데이터를 확인하세요. 본문, 토큰, 자격 증명과 공급자 응답 원문은 표시하지 않습니다."
        aside={<Badge>현재 목록 {collection.items.length}건</Badge>}
      />
      {!collection.smtpConfigured ? <div className="flex flex-col gap-3 rounded-lg border border-warning bg-subtle p-4" role="status"><strong>SMTP를 사용할 수 없습니다</strong><span>SMTP를 구성하기 전에는 대기 중인 이메일을 전송할 수 없습니다. 앱 내 알림은 계속 정상적으로 제공됩니다.</span></div> : null}
      <AdminSection className="overflow-hidden" aria-labelledby="delivery-list-title">
        <div className="flex items-center justify-between gap-3 px-4 py-3 max-[37.5rem]:flex-col max-[37.5rem]:items-stretch [&_h2]:m-0">
          <div><h2 id="delivery-list-title" className="text-sm">전송 내역</h2><p className="m-0 mt-1 text-xs text-muted-foreground">선택한 상태의 작업을 25건씩 확인합니다.</p></div>
          <SelectField
            label="상태"
            density="compact"
            options={FILTERS}
            value={state}
            disabled={mutation.isPending}
            onValueChange={(nextValue) => selectState(nextValue as EmailDeliveryState)}
          />
        </div>
        {collection.items.length === 0 ? <p className="m-0 grid min-h-48 place-content-center justify-items-center border-t border-muted-border text-center text-foreground">이 상태의 전송 작업이 없습니다.</p> : (
          <div className="overflow-x-auto border-t border-muted-border">
            <table className="w-full min-w-[58rem] table-fixed border-collapse text-left">
              <colgroup><col className="w-[22%]" /><col className="w-[15%]" /><col className="w-[21%]" /><col className="w-[10%]" /><col className="w-[9%]" /><col className="w-[13%]" /><col className="w-[10%]" /></colgroup>
              <thead className="bg-subtle/70 text-xs font-semibold text-muted-foreground [&_th]:border-b [&_th]:border-muted-border [&_th]:px-4 [&_th]:py-2.5"><tr><th scope="col">수신자</th><th scope="col">템플릿</th><th scope="col">리소스</th><th scope="col">상태</th><th scope="col">시도</th><th scope="col">최근 변경</th><th scope="col" className="text-right">작업</th></tr></thead>
              <tbody>
            {collection.items.map((delivery) => {
              const pending = (function () {
    if (confirmation?.id === delivery.id) {
        return (confirmation.operation);
    }
    return (undefined);
})();
              return (
                <EmailDeliveryRows delivery={delivery} key={delivery.id} pending={pending} disabled={mutation.isPending} onApply={apply} onCancelConfirmation={cancelConfirmation} />
              );
            })}
              </tbody>
            </table>
          </div>
        )}
        <footer className="flex items-center justify-between gap-4 border-t border-muted-border px-4 py-3 max-[37.5rem]:flex-col max-[37.5rem]:items-stretch"><span className="text-xs text-muted-foreground" aria-live="polite">{pageIndex + 1}페이지 · 현재 {collection.items.length}건 · 페이지당 최대 25건</span><nav className="flex justify-end gap-2 max-[37.5rem]:[&_[data-slot=button]]:flex-1" aria-label="이메일 전송 내역 페이지 이동"><Button size="sm" disabled={pageIndex === 0 || mutation.isPending} onClick={previousPage}>이전</Button><Button size="sm" variant="primary" disabled={(pageIndex >= pages.length - 1 && collection.nextCursor === null) || mutation.isPending} onClick={() => void nextPage()}>{mutation.isPending ? "불러오는 중…" : "다음"}</Button></nav></footer>
      </AdminSection>
      {feedback ? <AdminFeedback feedbackTone={(function () {
    if (feedback.error) {
        return ("danger");
    }
    return ("success");
})()} role={(function () {
    if (feedback.error) {
        return ("alert");
    }
    return ("status");
})()}>{feedback.text}</AdminFeedback> : null}
    </AdminPage>
  );
}

function EmailDeliveryRows({ delivery, disabled, onApply, onCancelConfirmation, pending }: { readonly delivery: EmailDelivery; readonly disabled: boolean; readonly onApply: (delivery: EmailDelivery, operation: "cancel" | "retry") => Promise<void>; readonly onCancelConfirmation: () => void; readonly pending: "cancel" | "retry" | undefined }) {
  return <>
    <tr className="hover:bg-hover [&>td]:border-b [&>td]:border-muted-border [&>td]:px-4 [&>td]:py-3 [&>td]:align-middle">
      <td><div className="grid min-w-0 gap-1"><strong className="truncate text-sm">{delivery.recipientEmail}</strong><span className="truncate text-xs text-muted-foreground">{delivery.errorClass ?? "오류 없음"}{delivery.smtpCode === null ? "" : ` · SMTP ${delivery.smtpCode}`}</span></div></td>
      <td><span className="block truncate text-xs" title={delivery.templateId}>{delivery.templateId}</span></td>
      <td><div className="grid min-w-0 gap-1"><span className="truncate text-sm">{delivery.resourceType}</span><span className="truncate font-mono text-xs text-muted-foreground" title={delivery.resourceId}>{delivery.resourceId}</span></div></td>
      <td><Badge size="sm" variant="status" tone={delivery.state === "sent" ? "success" : (function () {
    if (delivery.state === "dead_letter") {
        return ("danger");
    }
    return ("neutral");
})()}>{FILTERS.find((item) => item.value === delivery.state)?.label ?? delivery.state}</Badge></td>
      <td className="text-sm">{delivery.attemptCount}회</td>
      <td><time className="whitespace-nowrap text-xs text-muted-foreground" dateTime={delivery.updatedAt}>{formatDate(delivery.updatedAt)}</time></td>
      <td><div className="flex justify-end gap-2">{delivery.state === "dead_letter" ? <Button size="sm" variant={(function () {
    if (pending === "retry") {
        return ("danger");
    }
    return ("secondary");
})()} disabled={disabled} onClick={() => void onApply(delivery, "retry")}>{(function () {
    if (pending === "retry") {
        return ("확인");
    }
    return ("재시도");
})()}</Button> : null}{(["pending", "retry_wait"] as const).includes(delivery.state as "pending" | "retry_wait") ? <Button size="sm" variant={(function () {
    if (pending === "cancel") {
        return ("danger");
    }
    return ("secondary");
})()} disabled={disabled} onClick={() => void onApply(delivery, "cancel")}>{(function () {
    if (pending === "cancel") {
        return ("확인");
    }
    return ("폐기");
})()}</Button> : null}</div></td>
    </tr>
    {pending ? <tr><td className="border-b border-danger bg-subtle px-4 py-3 text-sm text-danger" colSpan={7}><div className="flex items-center justify-between gap-4"><span role="alert">{(function () {
    if (pending === "retry") {
        return ("현재 전송 가능 여부를 다시 확인한 뒤 새로운 시도를 만듭니다.");
    }
    return ("이 전송 작업만 영구적으로 폐기합니다.");
})()} 최근 관리자 재인증이 필요합니다.</span><Button size="sm" disabled={disabled} onClick={onCancelConfirmation}>취소</Button></div></td></tr> : null}
  </>;
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("ko-KR", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}
