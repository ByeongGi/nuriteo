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
import { AdminPage } from "#src/app/(admin)/admin/_components/admin-surface.tsx";

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
  const [collection, setCollection] = useState(initial);
  const [confirmation, setConfirmation] = useState<{ readonly id: string; readonly operation: "cancel" | "retry" }>();
  const [feedback, setFeedback] = useState<{ readonly error: boolean; readonly text: string }>();

  async function selectState(next: EmailDeliveryState) {
    setState(next);
    setConfirmation(undefined);
    await mutation.run(async () => {
      try {
        const result = await listEmailDeliveries(createBrowserApiClient(), { state: next, limit: 25 });
        setCollection(result.data);
        setFeedback(undefined);
      } catch (error) {
        setFeedback(deliveryFailure(error));
      }
    });
  }

  async function loadMore() {
    const cursor = collection.nextCursor;
    if (cursor === null) return;
    await mutation.run(async () => {
      try {
        const result = await listEmailDeliveries(createBrowserApiClient(), { state, cursor, limit: 25 });
        setCollection((current) => ({
          ...result.data,
          items: current === undefined
            ? result.data.items
            : mergeUniqueDeliveries(current.items, result.data.items)
        }));
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
        setCollection((current) => ({
          ...current,
          items: current.items.filter((item) => item.id !== delivery.id)
        }));
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
    <AdminPage id="main-content">
      <AdminPageHeader
        category="이메일 전송"
        title="이메일 전송"
        description="정제된 전송 메타데이터를 확인하세요. 본문, 토큰, 자격 증명과 공급자 응답 원문은 표시하지 않습니다."
        aside={<Badge>현재 목록 {collection.items.length}건</Badge>}
      />
      {!collection.smtpConfigured ? <div className="mt-4 flex flex-col gap-3 rounded-lg border border-warning bg-subtle p-4" role="status"><strong>SMTP를 사용할 수 없습니다</strong><span>SMTP를 구성하기 전에는 대기 중인 이메일을 전송할 수 없습니다. 앱 내 알림은 계속 정상적으로 제공됩니다.</span></div> : null}
      <section className="rounded-xl border border-muted-border bg-surface p-[clamp(1rem,3vw,2rem)]" aria-labelledby="delivery-list-title">
        <div className="flex items-center justify-between gap-3 max-[37.5rem]:flex-col max-[37.5rem]:items-stretch [&_h2]:m-0">
          <h2 id="delivery-list-title">전송 대기열</h2>
          <SelectField
            label="상태"
            density="compact"
            options={FILTERS}
            value={state}
            disabled={mutation.isPending}
            onValueChange={(nextValue) => selectState(nextValue as EmailDeliveryState)}
          />
        </div>
        {collection.items.length === 0 ? <p className="m-0 grid min-h-48 place-content-center justify-items-center rounded-lg border border-dashed border-border text-center text-foreground">이 상태의 전송 작업이 없습니다.</p> : (
          <div className="my-5 grid gap-3">
            {collection.items.map((delivery) => {
              const pending = confirmation?.id === delivery.id ? confirmation.operation : undefined;
              return (
                <article key={delivery.id} className="grid gap-4 rounded-lg border border-muted-border bg-raised p-4 [content-visibility:auto] [contain-intrinsic-size:auto_5rem] max-[37.5rem]:[&_dl]:grid-cols-1">
                  <div className="flex items-center justify-between gap-3 max-[37.5rem]:flex-col max-[37.5rem]:items-stretch [&_h3]:m-0 [&>span]:rounded-full [&>span]:bg-subtle [&>span]:px-2 [&>span]:py-1 [&>span]:text-xs"><h3>{delivery.recipientEmail}</h3><span>{FILTERS.find((item) => item.value === delivery.state)?.label ?? delivery.state}</span></div>
                  <dl className="m-0 grid grid-cols-3 gap-3 max-[37.5rem]:grid-cols-1 [&>div]:min-w-0 [&_dt]:text-xs [&_dt]:text-muted-foreground [&_dd]:mt-1 [&_dd]:[overflow-wrap:anywhere]">
                    <div><dt>템플릿</dt><dd>{delivery.templateId}</dd></div>
                    <div><dt>리소스</dt><dd>{delivery.resourceType}: {delivery.resourceId}</dd></div>
                    <div><dt>시도 횟수</dt><dd>{delivery.attemptCount}</dd></div>
                    <div><dt>정제된 오류</dt><dd>{delivery.errorClass ?? "없음"}{delivery.smtpCode === null ? "" : ` · SMTP ${delivery.smtpCode}`}</dd></div>
                    <div><dt>최근 변경</dt><dd><time dateTime={delivery.updatedAt}>{formatDate(delivery.updatedAt)}</time></dd></div>
                    <div><dt>처리 가능 시각</dt><dd><time dateTime={delivery.availableAt}>{formatDate(delivery.availableAt)}</time></dd></div>
                  </dl>
                  <div className="flex flex-wrap items-center justify-between gap-2 max-[37.5rem]:flex-col max-[37.5rem]:items-stretch max-[37.5rem]:[&_[data-slot=button]]:w-full">
                    {delivery.state === "dead_letter" ? <Button variant={pending === "retry" ? "danger" : "secondary"} disabled={mutation.isPending} onClick={() => apply(delivery, "retry")}>{pending === "retry" ? "재시도 확인" : "지금 재시도"}</Button> : null}
                    {(["pending", "retry_wait"] as const).includes(delivery.state as "pending" | "retry_wait") ? <Button variant={pending === "cancel" ? "danger" : "secondary"} disabled={mutation.isPending} onClick={() => apply(delivery, "cancel")}>{pending === "cancel" ? "폐기 확인" : "폐기"}</Button> : null}
                    {pending ? <Button disabled={mutation.isPending} onClick={() => setConfirmation(undefined)}>작업 유지</Button> : null}
                  </div>
                  {pending ? <p className="m-0 font-medium text-danger" role="alert">{pending === "retry" ? "현재 전송 가능 여부를 다시 확인한 뒤 새로운 시도를 만듭니다." : "이 전송 작업만 영구적으로 폐기합니다."} 최근 관리자 재인증이 필요합니다.</p> : null}
                </article>
              );
            })}
          </div>
        )}
        {collection.nextCursor !== null ? <Button disabled={mutation.isPending} onClick={loadMore}>{mutation.isPending ? "불러오는 중…" : "더 보기"}</Button> : null}
      </section>
      {feedback ? <p className={`mt-4 flex gap-3 rounded-lg border p-4 ${feedback.error ? "border-danger" : "border-success"}`} role={feedback.error ? "alert" : "status"}>{feedback.text}</p> : null}
    </AdminPage>
  );
}

function mergeUniqueDeliveries(current: readonly EmailDelivery[], incoming: readonly EmailDelivery[]) {
  const known = new Set(current.map((item) => item.id));
  return [...current, ...incoming.filter((item) => !known.has(item.id))];
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("ko-KR", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function deliveryFailure(error: unknown): { readonly error: true; readonly text: string } {
  if (error instanceof ApiError && error.status === 403) return { error: true, text: "최근 관리자 재인증 또는 인스턴스 관리자 권한이 필요합니다." };
  if (error instanceof ApiError && (error.status === 412 || error.status === 428 || error.code === "COMMIT_OUTCOME_UNKNOWN")) return { error: true, text: "전송 상태가 변경되었을 수 있습니다. 대기열을 새로 고친 뒤 다시 시도하세요." };
  if (error instanceof ApiError && error.status === 409) return { error: true, text: "현재 전송 상태에서는 이 작업을 수행할 수 없습니다. 대기열을 새로 고쳐 주세요." };
  return { error: true, text: "전송 작업을 안전하게 완료하지 못했습니다." };
}
