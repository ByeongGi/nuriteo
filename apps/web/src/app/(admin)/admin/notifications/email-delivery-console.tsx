"use client";

import {
  ApiError,
  cancelEmailDelivery,
  listEmailDeliveries,
  retryEmailDelivery
} from "@nuriteo/api-client";
import type { EmailDelivery, EmailDeliveryCollection, EmailDeliveryState } from "@nuriteo/api-client";
import { useState } from "react";

import { Badge } from "#src/components/ui/badge.tsx";
import { Button } from "#src/components/ui/button.tsx";
import { SelectField } from "#src/components/ui/field.tsx";
import { createBrowserApiClient } from "#src/lib/api/browser-client.ts";
import { readCsrfCredential } from "#src/lib/api/browser-security.ts";
import { useExclusiveMutation } from "#src/lib/use-exclusive-mutation.ts";
import { AdminPageHeader } from "#src/app/(admin)/admin/_components/admin-page-header.tsx";
import { AdminFeedback, AdminPage, AdminSection } from "#src/app/(admin)/admin/_components/admin-surface.tsx";

const FILTERS: readonly { readonly value: EmailDeliveryState; readonly label: string }[] = [
  { value: "dead_letter", label: "최종 실패" },
  { value: "retry_wait", label: "재시도 대기" },
  { value: "pending", label: "전송 대기" },
  { value: "sending", label: "전송 중" },
  { value: "sent", label: "전송 완료" },
  { value: "canceled", label: "폐기됨" }
];

export function EmailDeliveryConsole({ initial }: { readonly initial: EmailDeliveryCollection }) {
  const mutation = useExclusiveMutation();
  const [state, setState] = useState<EmailDeliveryState>("dead_letter");
  const [pages, setPages] = useState<readonly EmailDeliveryCollection[]>([initial]);
  const [pageIndex, setPageIndex] = useState(0);
  const [confirmation, setConfirmation] = useState<{ readonly id: string; readonly operation: "cancel" | "retry" }>();
  const [feedback, setFeedback] = useState<{ readonly error: boolean; readonly text: string }>();
  const collection = pages[pageIndex] ?? initial;

  async function selectState(next: EmailDeliveryState) {
    setState(next);
    setConfirmation(undefined);
    await mutation.run(async () => {
      try {
        const result = await listEmailDeliveries(createBrowserApiClient(), { state: next, limit: 25 });
        setPages([result.data]);
        setPageIndex(0);
        setFeedback(undefined);
      } catch (error) {
        setFeedback(deliveryFailure(error));
      }
    });
  }

  async function nextPage() {
    if (pageIndex < pages.length - 1) {
      setPageIndex((current) => current + 1);
      return;
    }
    const cursor = collection.nextCursor;
    if (cursor === null) return;
    await mutation.run(async () => {
      try {
        const result = await listEmailDeliveries(createBrowserApiClient(), { state, cursor, limit: 25 });
        setPages((current) => [...current, result.data]);
        setPageIndex((current) => current + 1);
      } catch (error) {
        setFeedback(deliveryFailure(error));
      }
    });
  }

  async function apply(delivery: EmailDelivery, operation: "cancel" | "retry") {
    if (confirmation?.id !== delivery.id || confirmation.operation !== operation) {
      setConfirmation({ id: delivery.id, operation });
      return;
    }
    await mutation.run(async () => {
      try {
        const options = {
          csrfToken: readCsrfCredential(),
          idempotencyKey: `notification-${operation}-${crypto.randomUUID()}`
        };
        const result = operation === "retry"
          ? await retryEmailDelivery(createBrowserApiClient(), delivery, options)
          : await cancelEmailDelivery(createBrowserApiClient(), delivery, options);
        setPages((current) => current.map((page) => ({ ...page, items: page.items.filter((item) => item.id !== delivery.id) })));
        setConfirmation(undefined);
        setFeedback({
          error: false,
          text: operation === "retry"
            ? `새 전송 작업 ${result.data.id}을(를) 만들었습니다.`
            : "연결된 도메인 리소스는 변경하지 않고 이 전송 작업만 폐기했습니다."
        });
      } catch (error) {
        setConfirmation(undefined);
        setFeedback(deliveryFailure(error));
      }
    });
  }

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
              const pending = confirmation?.id === delivery.id ? confirmation.operation : undefined;
              return (
                <EmailDeliveryRows delivery={delivery} key={delivery.id} pending={pending} disabled={mutation.isPending} onApply={apply} onCancelConfirmation={() => setConfirmation(undefined)} />
              );
            })}
              </tbody>
            </table>
          </div>
        )}
        <footer className="flex items-center justify-between gap-4 border-t border-muted-border px-4 py-3 max-[37.5rem]:flex-col max-[37.5rem]:items-stretch"><span className="text-xs text-muted-foreground" aria-live="polite">{pageIndex + 1}페이지 · 현재 {collection.items.length}건 · 페이지당 최대 25건</span><nav className="flex justify-end gap-2 max-[37.5rem]:[&_[data-slot=button]]:flex-1" aria-label="이메일 전송 내역 페이지 이동"><Button size="sm" disabled={pageIndex === 0 || mutation.isPending} onClick={() => setPageIndex((current) => Math.max(0, current - 1))}>이전</Button><Button size="sm" variant="primary" disabled={(pageIndex >= pages.length - 1 && collection.nextCursor === null) || mutation.isPending} onClick={() => void nextPage()}>{mutation.isPending ? "불러오는 중…" : "다음"}</Button></nav></footer>
      </AdminSection>
      {feedback ? <AdminFeedback feedbackTone={feedback.error ? "danger" : "success"} role={feedback.error ? "alert" : "status"}>{feedback.text}</AdminFeedback> : null}
    </AdminPage>
  );
}

function EmailDeliveryRows({ delivery, disabled, onApply, onCancelConfirmation, pending }: { readonly delivery: EmailDelivery; readonly disabled: boolean; readonly onApply: (delivery: EmailDelivery, operation: "cancel" | "retry") => Promise<void>; readonly onCancelConfirmation: () => void; readonly pending: "cancel" | "retry" | undefined }) {
  return <>
    <tr className="hover:bg-hover [&>td]:border-b [&>td]:border-muted-border [&>td]:px-4 [&>td]:py-3 [&>td]:align-middle">
      <td><div className="grid min-w-0 gap-1"><strong className="truncate text-sm">{delivery.recipientEmail}</strong><span className="truncate text-xs text-muted-foreground">{delivery.errorClass ?? "오류 없음"}{delivery.smtpCode === null ? "" : ` · SMTP ${delivery.smtpCode}`}</span></div></td>
      <td><span className="block truncate text-xs" title={delivery.templateId}>{delivery.templateId}</span></td>
      <td><div className="grid min-w-0 gap-1"><span className="truncate text-sm">{delivery.resourceType}</span><span className="truncate font-mono text-xs text-muted-foreground" title={delivery.resourceId}>{delivery.resourceId}</span></div></td>
      <td><Badge size="sm" variant="status" tone={delivery.state === "sent" ? "success" : delivery.state === "dead_letter" ? "danger" : "neutral"}>{FILTERS.find((item) => item.value === delivery.state)?.label ?? delivery.state}</Badge></td>
      <td className="text-sm">{delivery.attemptCount}회</td>
      <td><time className="whitespace-nowrap text-xs text-muted-foreground" dateTime={delivery.updatedAt}>{formatDate(delivery.updatedAt)}</time></td>
      <td><div className="flex justify-end gap-2">{delivery.state === "dead_letter" ? <Button size="sm" variant={pending === "retry" ? "danger" : "secondary"} disabled={disabled} onClick={() => void onApply(delivery, "retry")}>{pending === "retry" ? "확인" : "재시도"}</Button> : null}{(["pending", "retry_wait"] as const).includes(delivery.state as "pending" | "retry_wait") ? <Button size="sm" variant={pending === "cancel" ? "danger" : "secondary"} disabled={disabled} onClick={() => void onApply(delivery, "cancel")}>{pending === "cancel" ? "확인" : "폐기"}</Button> : null}</div></td>
    </tr>
    {pending ? <tr><td className="border-b border-danger bg-subtle px-4 py-3 text-sm text-danger" colSpan={7}><div className="flex items-center justify-between gap-4"><span role="alert">{pending === "retry" ? "현재 전송 가능 여부를 다시 확인한 뒤 새로운 시도를 만듭니다." : "이 전송 작업만 영구적으로 폐기합니다."} 최근 관리자 재인증이 필요합니다.</span><Button size="sm" disabled={disabled} onClick={onCancelConfirmation}>취소</Button></div></td></tr> : null}
  </>;
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("ko-KR", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function deliveryFailure(error: unknown): { readonly error: true; readonly text: string } {
  if (error instanceof ApiError && error.code === "REAUTHENTICATION_REQUIRED") return { error: true, text: "보안을 위해 다시 로그인한 뒤 전송 작업을 다시 시도하세요." };
  if (error instanceof ApiError && error.status === 403) return { error: true, text: "이 전송 작업을 수행할 관리자 권한이 없습니다." };
  if (error instanceof ApiError && (error.status === 412 || error.status === 428 || error.code === "COMMIT_OUTCOME_UNKNOWN")) return { error: true, text: "전송 상태가 변경되었을 수 있습니다. 대기열을 새로 고친 뒤 다시 시도하세요." };
  if (error instanceof ApiError && error.status === 409) return { error: true, text: "현재 전송 상태에서는 이 작업을 수행할 수 없습니다. 대기열을 새로 고쳐 주세요." };
  return { error: true, text: "전송 작업을 안전하게 완료하지 못했습니다." };
}
