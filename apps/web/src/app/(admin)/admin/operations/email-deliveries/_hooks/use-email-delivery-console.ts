"use client";

import { useState } from "react";

import { createBrowserApiClient } from "@/lib/api/browser-client.ts";
import { readCsrfCredential } from "@/lib/api/browser-security.ts";
import { useExclusiveMutation } from "@/lib/use-exclusive-mutation.ts";
import { cancelEmailDelivery, listEmailDeliveries, retryEmailDelivery } from "@/services/email/api.ts";
import { ApiError } from "@/services/http/api.ts";

import type { EmailDelivery, EmailDeliveryCollection, EmailDeliveryState } from "@nuriteo/api-client";

export function useEmailDeliveryConsole(initial: EmailDeliveryCollection) {
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

  function previousPage() {
    setPageIndex((current) => Math.max(0, current - 1));
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

  return {
    apply,
    cancelConfirmation: () => setConfirmation(undefined),
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
  };
}

function deliveryFailure(error: unknown): { readonly error: true; readonly text: string } {
  if (error instanceof ApiError && error.code === "REAUTHENTICATION_REQUIRED") return { error: true, text: "보안을 위해 다시 로그인한 뒤 전송 작업을 다시 시도하세요." };
  if (error instanceof ApiError && error.status === 403) return { error: true, text: "이 전송 작업을 수행할 관리자 권한이 없습니다." };
  if (error instanceof ApiError && (error.status === 412 || error.status === 428 || error.code === "COMMIT_OUTCOME_UNKNOWN")) return { error: true, text: "전송 상태가 변경되었을 수 있습니다. 대기열을 새로 고친 뒤 다시 시도하세요." };
  if (error instanceof ApiError && error.status === 409) return { error: true, text: "현재 전송 상태에서는 이 작업을 수행할 수 없습니다. 대기열을 새로 고쳐 주세요." };
  return { error: true, text: "전송 작업을 안전하게 완료하지 못했습니다." };
}
