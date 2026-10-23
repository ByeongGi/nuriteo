"use client";

import {
  issueActivationInvitation,
  reissueActivationInvitation,
  revokeActivationInvitation
} from "@nuriteo/api-client";
import type { ActivationInvitation } from "@nuriteo/api-client";
import { useRouter } from "next/navigation";
import { useDeferredValue, useState } from "react";
import type { FormEvent } from "react";

import { Badge } from "#src/components/ui/badge.tsx";
import { Button } from "#src/components/ui/button.tsx";
import { CollapsibleContent, CollapsibleIndicator, CollapsiblePanel, CollapsibleRoot, CollapsibleTrigger } from "#src/components/ui/collapsible.tsx";
import { SelectField, TextField } from "#src/components/ui/field.tsx";
import { createBrowserApiClient } from "#src/lib/api/browser-client.ts";
import { collaborationError, readCsrfCredential } from "#src/lib/api/browser-security.ts";
import { useExclusiveMutation } from "#src/lib/use-exclusive-mutation.ts";
import { AdminPageHeader } from "#src/app/(admin)/admin/_components/admin-page-header.tsx";
import { AdminCollectionHeading, AdminPage, AdminPanel } from "#src/app/(admin)/admin/_components/admin-surface.tsx";

const EXPIRATION_OPTIONS = [
  { value: "86400", label: "1일" },
  { value: "604800", label: "7일" },
  { value: "1209600", label: "14일" },
  { value: "2592000", label: "30일" }
] as const;

const STATUS_OPTIONS = [
  { value: "all", label: "모든 상태" },
  { value: "pending", label: "대기 중" },
  { value: "accepted", label: "활성화 완료" },
  { value: "expired", label: "만료됨" },
  { value: "revoked", label: "취소됨" }
] as const;

export function ActivationInvitations({
  invitations
}: {
  invitations: readonly ActivationInvitation[];
}) {
  const router = useRouter();
  const mutation = useExclusiveMutation();
  const [oneTimeUrl, setOneTimeUrl] = useState<string>();
  const [deliveryNotice, setDeliveryNotice] = useState<string>();
  const [error, setError] = useState<string>();
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | ActivationInvitation["status"]>("all");

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
        router.refresh();
      } catch (cause) {
        setError(collaborationError(cause, operation));
      }
    });
  }

  async function issue(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    await mutate("activation-invitation-issue", async () => {
      const result = await issueActivationInvitation(
        createBrowserApiClient(),
        {
          email: String(data.get("email") ?? ""),
          expiresInSeconds: Number(data.get("expiresInSeconds"))
        },
        { csrfToken: readCsrfCredential() }
      );
      if (result.data.delivery === "email_queued") {
        setDeliveryNotice("계정 활성화 이메일을 전송 대기열에 추가했습니다.");
      } else {
        setOneTimeUrl(result.data.activationUrl.consume());
      }
      form.reset();
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

  const pendingCount = invitations.filter((invitation) => invitation.status === "pending").length;
  const deferredQuery = useDeferredValue(query).trim().toLocaleLowerCase("ko-KR");
  const visibleInvitations = invitations.filter((invitation) => (
    (statusFilter === "all" || invitation.status === statusFilter)
    && (deferredQuery.length === 0 || invitation.email.toLocaleLowerCase("ko-KR").includes(deferredQuery))
  ));

  return (
    <AdminPage id="main-content">
      <AdminPageHeader
        category="가입 초대"
        title="계정 활성화"
        description="일회용 계정 활성화 링크를 발급합니다. 이메일 전송이 구성되어 있으면 링크를 이 화면에 표시하지 않고 이메일로 보냅니다."
        aside={<Badge>대기 중 {pendingCount}개</Badge>}
      />
      {oneTimeUrl ? (
        <section className="one-time-panel" aria-live="polite">
          <h2>지금 링크를 복사하세요</h2>
          <output>{oneTimeUrl}</output>
          <Button type="button" disabled={mutation.isPending} onClick={() => setOneTimeUrl(undefined)}>
            링크 지우기
          </Button>
        </section>
      ) : null}
      {deliveryNotice ? <p role="status">{deliveryNotice}</p> : null}
      {error ? <p className="form-error" role="alert">{error}</p> : null}
      <AdminPanel className="admin-create-panel" aria-labelledby="issue-invitation-title">
        <CollapsibleRoot defaultOpen={invitations.length === 0}>
          <CollapsibleTrigger className="max-[48rem]:[&_small]:hidden"><span id="issue-invitation-title">새 계정 초대</span><small>링크는 한 번만 사용할 수 있습니다</small><CollapsibleIndicator>⌄</CollapsibleIndicator></CollapsibleTrigger>
          <CollapsiblePanel><CollapsibleContent><form className="collaboration-form admin-invitation-form max-[48rem]:grid-cols-1 max-[48rem]:[&>[data-slot=button]]:col-start-1 max-[48rem]:[&>[data-slot=button]]:w-full max-[48rem]:[&>[data-slot=button]]:justify-self-stretch" onSubmit={issue} aria-busy={mutation.isPending}>
            <TextField label="초대받을 이메일" name="email" type="email" required maxLength={320} autoComplete="email" disabled={mutation.isPending} />
            <SelectField label="유효 기간" name="expiresInSeconds" defaultValue="604800" options={EXPIRATION_OPTIONS} required disabled={mutation.isPending} />
            <Button type="submit" variant="primary" disabled={mutation.isPending}>
              {mutation.isPending ? "처리 중…" : "초대 발급"}
            </Button>
          </form></CollapsibleContent></CollapsiblePanel>
        </CollapsibleRoot>
      </AdminPanel>
      <AdminPanel aria-labelledby="invitation-list-title">
        <AdminCollectionHeading><h2 id="invitation-list-title">발급 내역</h2><Badge>전체 {invitations.length}개</Badge></AdminCollectionHeading>
        <div className="admin-collection-toolbar max-[48rem]:grid-cols-1" role="search" aria-label="계정 초대 검색 및 필터">
          <TextField label="이메일 검색" labelHidden density="compact" type="search" value={query} onChange={(event) => setQuery(event.currentTarget.value)} placeholder="이메일 검색" />
          <SelectField label="초대 상태" labelHidden density="compact" options={STATUS_OPTIONS} value={statusFilter} onValueChange={(nextValue) => setStatusFilter(nextValue as "all" | ActivationInvitation["status"])} />
          <span aria-live="polite">{visibleInvitations.length}개 표시</span>
        </div>
        {invitations.length === 0 ? <p>발급한 계정 초대가 없습니다.</p> : visibleInvitations.length === 0 ? <p>검색 조건에 맞는 초대가 없습니다.</p> : <ul className="record-list" aria-label="계정 활성화 초대">
          {visibleInvitations.map((invitation) => (
          <li key={invitation.id}>
            <div>
              <strong>{invitation.email}</strong>
              <span><b className="admin-record-status" data-status={invitation.status}>{invitationStatusLabel(invitation.status)}</b> · {new Date(invitation.expires_at).toLocaleString("ko-KR")} 만료</span>
            </div>
            {invitation.status === "pending" ? (
              <div className="record-actions">
                <Button type="button" disabled={mutation.isPending} onClick={() => void reissue(invitation.id)}>다시 발급</Button>
                <Button type="button" disabled={mutation.isPending} onClick={() => void revoke(invitation.id)}>초대 취소</Button>
              </div>
            ) : null}
          </li>
          ))}
        </ul>}
      </AdminPanel>
    </AdminPage>
  );
}

function invitationStatusLabel(status: ActivationInvitation["status"]): string {
  if (status === "pending") return "대기 중";
  if (status === "accepted") return "활성화 완료";
  if (status === "revoked") return "취소됨";
  return "만료됨";
}
