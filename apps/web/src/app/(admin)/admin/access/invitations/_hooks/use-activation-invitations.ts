"use client";

import { useRouter } from "next/navigation";
import { useDeferredValue, useState } from "react";

import { activationInvitationSchema } from "@/app/(admin)/admin/access/invitations/_schema/activation-invitation.ts";
import { createBrowserApiClient } from "@/lib/api/browser-client.ts";
import { collaborationError, readCsrfCredential } from "@/lib/api/browser-security.ts";
import { useExclusiveMutation } from "@/lib/use-exclusive-mutation.ts";
import { issueActivationInvitation, listActivationInvitations, reissueActivationInvitation, revokeActivationInvitation } from "@/services/activation/api.ts";

import type { ChangeEvent, FormEvent } from "react";
import type { ActivationInvitation, ActivationInvitationCollection } from "@nuriteo/api-client";

export function useActivationInvitations(initial: ActivationInvitationCollection) {
  const router = useRouter();
  const mutation = useExclusiveMutation();
  const [oneTimeUrl, setOneTimeUrl] = useState<string>();
  const [deliveryNotice, setDeliveryNotice] = useState<string>();
  const [error, setError] = useState<string>();
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | ActivationInvitation["status"]>("all");
  const [pages, setPages] = useState<readonly ActivationInvitationCollection[]>([initial]);
  const [pageIndex, setPageIndex] = useState(0);
  const [pageLoading, setPageLoading] = useState(false);
  const page = pages[pageIndex] ?? initial;
  const invitations = page.items;
  const pendingCount = invitations.filter((invitation) => invitation.status === "pending").length;
  const deferredQuery = useDeferredValue(query).trim().toLocaleLowerCase("ko-KR");
  const visibleInvitations = invitations.filter((invitation) => (
    (statusFilter === "all" || invitation.status === statusFilter)
    && (deferredQuery.length === 0 || invitation.email.toLocaleLowerCase("ko-KR").includes(deferredQuery))
  ));

  async function mutate(
    operation: "activation-invitation-issue" | "activation-invitation-terminal",
    action: () => Promise<void>
  ) {
    await mutation.run(async () => {
      setError(undefined);
      setOneTimeUrl(undefined);
      setDeliveryNotice(undefined);
      try {
        await action();
        try {
          const refreshed = await listActivationInvitations(createBrowserApiClient(), { limit: 25 });
          setPages([refreshed.data]);
          setPageIndex(0);
        } catch {
          setError("요청은 처리되었지만 최신 초대 내역을 불러오지 못했습니다. 페이지를 새로고침해 주세요.");
        }
        router.refresh();
      } catch (cause) {
        setError(collaborationError(cause, operation));
      }
    });
  }

  async function reissue(invitationId: string) {
    await mutate("activation-invitation-terminal", async () => {
      const result = await reissueActivationInvitation(
        createBrowserApiClient(),
        { invitationId },
        { csrfToken: readCsrfCredential() }
      );
      if (result.data.delivery === "email_queued") {
        setDeliveryNotice("새 계정 활성화 이메일을 전송 대기열에 추가했습니다.");
      } else {
        setOneTimeUrl(result.data.activationUrl.consume());
      }
    });
  }

  async function revoke(invitationId: string) {
    await mutate("activation-invitation-terminal", async () => {
      await revokeActivationInvitation(
        createBrowserApiClient(),
        invitationId,
        { csrfToken: readCsrfCredential() }
      );
    });
  }

  async function nextPage() {
    if (pageIndex < pages.length - 1) {
      setPageIndex((current) => current + 1);
      return;
    }
    if (page.nextCursor === null || pageLoading) return;
    setPageLoading(true);
    setError(undefined);
    try {
      const result = await listActivationInvitations(createBrowserApiClient(), { cursor: page.nextCursor, limit: 25 });
      setPages((current) => [...current, result.data]);
      setPageIndex((current) => current + 1);
    } catch (cause) {
      setError(collaborationError(cause, "activation-invitation-terminal"));
    } finally {
      setPageLoading(false);
    }
  }

  return {
    dismissOneTimeUrl: () => setOneTimeUrl(undefined),
    deliveryNotice,
    error,
    invitations,
    mutation,
    nextPage,
    oneTimeUrl,
    page,
    pageIndex,
    pageLoading,
    pages,
    pendingCount,
    previousPage: () => setPageIndex((current) => Math.max(0, current - 1)),
    onQueryChange: (event: ChangeEvent<HTMLInputElement>) => setQuery(event.currentTarget.value),
    query,
    reissue,
    revoke,
    setQuery,
    setStatusFilter,
    statusFilter,
    visibleInvitations
  };
}

export function useNewActivationInvitation() {
  const mutation = useExclusiveMutation();
  const [oneTimeUrl, setOneTimeUrl] = useState<string>();
  const [deliveryNotice, setDeliveryNotice] = useState<string>();
  const [error, setError] = useState<string>();

  async function issue(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const parsed = activationInvitationSchema.safeParse({
      email: String(data.get("email") ?? ""),
      expiresInSeconds: Number(data.get("expiresInSeconds"))
    });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "이메일을 입력하세요.");
      return;
    }
    await mutation.run(async () => {
      setError(undefined);
      setOneTimeUrl(undefined);
      setDeliveryNotice(undefined);
      try {
        const result = await issueActivationInvitation(
          createBrowserApiClient(),
          {
            email: parsed.data.email,
            expiresInSeconds: parsed.data.expiresInSeconds
          },
          { csrfToken: readCsrfCredential() }
        );
        if (result.data.delivery === "email_queued") {
          setDeliveryNotice("계정 활성화 이메일을 전송 대기열에 추가했습니다.");
        } else {
          setOneTimeUrl(result.data.activationUrl.consume());
        }
        form.reset();
      } catch (cause) {
        setError(collaborationError(cause, "activation-invitation-issue"));
      }
    });
  }

  return { deliveryNotice, error, issue, mutation, oneTimeUrl };
}
