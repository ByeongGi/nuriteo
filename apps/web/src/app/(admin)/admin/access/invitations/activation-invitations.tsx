"use client";

import {
  issueActivationInvitation,
  listActivationInvitations,
  reissueActivationInvitation,
  revokeActivationInvitation
} from "@nuriteo/api-client";
import type { ActivationInvitation, ActivationInvitationCollection } from "@nuriteo/api-client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useDeferredValue, useState } from "react";
import type { FormEvent } from "react";

import { Badge } from "#src/components/ui/badge.tsx";
import { buttonVariants } from "#src/components/ui/button.styles.ts";
import { Button } from "#src/components/ui/button.tsx";
import { SelectField, TextField } from "#src/components/ui/field.tsx";
import { createBrowserApiClient } from "#src/lib/api/browser-client.ts";
import { collaborationError, readCsrfCredential } from "#src/lib/api/browser-security.ts";
import { useExclusiveMutation } from "#src/lib/use-exclusive-mutation.ts";
import { AdminPageHeader } from "#src/app/(admin)/admin/_components/admin-page-header.tsx";
import { AdminCollectionHeading, AdminNote, AdminPage, AdminPanel, AdminSection, AdminSectionHeading } from "#src/app/(admin)/admin/_components/admin-surface.tsx";

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
  { value: "revoked", label: "취소됨" },
  { value: "superseded", label: "재발급됨" }
] as const;

export function ActivationInvitations({
  initial
}: {
  initial: ActivationInvitationCollection;
}) {
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

  const pendingCount = invitations.filter((invitation) => invitation.status === "pending").length;
  const deferredQuery = useDeferredValue(query).trim().toLocaleLowerCase("ko-KR");
  const visibleInvitations = invitations.filter((invitation) => (
    (statusFilter === "all" || invitation.status === statusFilter)
    && (deferredQuery.length === 0 || invitation.email.toLocaleLowerCase("ko-KR").includes(deferredQuery))
  ));

  return (
    <AdminPage id="main-content" contentWidth="standard">
      <AdminPageHeader
        category="접근 관리"
        title="사용자 초대"
        description="발급한 초대의 전달 상태와 만료 여부를 확인하고, 필요한 초대만 다시 발급하거나 취소합니다."
        aside={<div className="flex items-center gap-2"><Badge>대기 중 {pendingCount}개</Badge><Link className={buttonVariants({ variant: "primary" })} href="/admin/access/invitations/new">새 사용자 초대</Link></div>}
      />
      {oneTimeUrl ? <AdminSection className="border-warning" aria-live="polite"><AdminSectionHeading><div><h2>새 활성화 링크</h2><p>보안을 위해 이 링크는 다시 표시되지 않습니다.</p></div><Button type="button" size="sm" onClick={() => setOneTimeUrl(undefined)}>닫기</Button></AdminSectionHeading><div className="border-t border-muted-border p-4"><output className="block select-all rounded-md bg-subtle p-3 font-mono text-sm [overflow-wrap:anywhere]">{oneTimeUrl}</output></div></AdminSection> : null}
      {deliveryNotice ? <p role="status">{deliveryNotice}</p> : null}
      {error ? <p className="rounded-md border border-danger bg-subtle p-3 text-danger" role="alert">{error}</p> : null}
      <AdminPanel aria-labelledby="invitation-list-title">
        <AdminCollectionHeading><h2 id="invitation-list-title">초대 내역</h2><Badge>전체 {invitations.length}개</Badge></AdminCollectionHeading>
        <div className="mb-4 grid grid-cols-[minmax(12rem,1fr)_12rem_auto] items-end gap-3 rounded-lg border border-muted-border bg-subtle p-3 max-[48rem]:grid-cols-1 [&>span]:self-center [&>span]:text-xs [&>span]:text-muted-foreground" role="search" aria-label="계정 초대 검색 및 필터">
          <TextField label="이메일 검색" labelHidden density="compact" type="search" value={query} onChange={(event) => setQuery(event.currentTarget.value)} placeholder="이메일 검색" />
          <SelectField label="초대 상태" labelHidden density="compact" options={STATUS_OPTIONS} value={statusFilter} onValueChange={(nextValue) => setStatusFilter(nextValue as "all" | ActivationInvitation["status"])} />
          <span aria-live="polite">현재 페이지 {visibleInvitations.length}개</span>
        </div>
        {invitations.length === 0 ? <AdminNote>발급한 사용자 초대가 없습니다.</AdminNote> : visibleInvitations.length === 0 ? <AdminNote>검색 조건에 맞는 초대가 없습니다.</AdminNote> : <div className="overflow-x-auto border-t border-muted-border"><table className="w-full min-w-[52rem] border-collapse text-left text-sm" aria-label="사용자 초대 내역"><thead className="bg-subtle text-xs text-muted-foreground"><tr><th className="px-4 py-2.5 font-medium" scope="col">사용자</th><th className="px-4 py-2.5 font-medium" scope="col">상태</th><th className="px-4 py-2.5 font-medium" scope="col">만료 시각</th><th className="px-4 py-2.5 text-right font-medium" scope="col">관리</th></tr></thead><tbody>{visibleInvitations.map((invitation) => <tr className="border-t border-muted-border" key={invitation.id}><td className="px-4 py-3 font-medium text-foreground">{invitation.email}</td><td className="px-4 py-3"><span className="font-semibold text-muted-foreground data-[status=accepted]:text-success data-[status=pending]:text-warning" data-status={invitation.status}>{invitationStatusLabel(invitation.status)}</span></td><td className="px-4 py-3 text-muted-foreground"><time dateTime={invitation.expires_at}>{new Date(invitation.expires_at).toLocaleString("ko-KR")}</time></td><td className="px-4 py-3"><div className="flex justify-end gap-2">{invitation.status === "pending" ? <><Button size="sm" type="button" disabled={mutation.isPending} onClick={() => void reissue(invitation.id)}>다시 발급</Button><Button size="sm" variant="danger" type="button" disabled={mutation.isPending} onClick={() => void revoke(invitation.id)}>초대 취소</Button></> : <span className="text-xs text-muted-foreground">작업 없음</span>}</div></td></tr>)}</tbody></table></div>}
        <footer className="mt-4 flex items-center justify-between gap-4 border-t border-muted-border pt-3 max-[37.5rem]:flex-col max-[37.5rem]:items-stretch"><span className="text-xs text-muted-foreground">{pageIndex + 1}페이지 · 현재 {invitations.length}건</span><nav className="flex justify-end gap-2 max-[37.5rem]:[&_[data-slot=button]]:flex-1" aria-label="사용자 초대 페이지 이동"><Button size="sm" disabled={pageIndex === 0 || pageLoading} onClick={() => setPageIndex((current) => Math.max(0, current - 1))}>이전</Button><Button size="sm" variant="primary" disabled={(pageIndex >= pages.length - 1 && page.nextCursor === null) || pageLoading} onClick={() => void nextPage()}>{pageLoading ? "불러오는 중…" : "다음"}</Button></nav></footer>
      </AdminPanel>
    </AdminPage>
  );
}

export function NewActivationInvitation() {
  const mutation = useExclusiveMutation();
  const [oneTimeUrl, setOneTimeUrl] = useState<string>();
  const [deliveryNotice, setDeliveryNotice] = useState<string>();
  const [error, setError] = useState<string>();

  async function issue(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    await mutation.run(async () => {
      setError(undefined);
      setOneTimeUrl(undefined);
      setDeliveryNotice(undefined);
      try {
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
      } catch (cause) {
        setError(collaborationError(cause, "activation-invitation-issue"));
      }
    });
  }

  return (
    <AdminPage id="main-content" contentWidth="narrow">
      <Link className="inline-flex w-fit items-center gap-2 text-xs font-medium text-muted-foreground hover:text-foreground" href="/admin/access/invitations"><span aria-hidden="true">←</span>초대 목록</Link>
      <AdminPageHeader
        category="접근 관리"
        title="새 사용자 초대"
        description="초대할 사용자와 유효 기간만 확인한 뒤 계정 활성화 링크를 발급합니다."
      />
      {oneTimeUrl ? (
        <AdminSection className="border-warning" aria-live="polite">
          <AdminSectionHeading><div><h2>활성화 링크가 준비되었습니다</h2><p>보안을 위해 이 링크는 다시 표시되지 않습니다.</p></div></AdminSectionHeading>
          <div className="grid gap-3 border-t border-muted-border p-4">
            <output className="select-all rounded-md bg-subtle p-3 font-mono text-sm [overflow-wrap:anywhere]">{oneTimeUrl}</output>
            <div className="flex justify-end"><Link className={buttonVariants({ variant: "primary" })} href="/admin/access/invitations">초대 목록으로 이동</Link></div>
          </div>
        </AdminSection>
      ) : (
        <AdminSection>
          <AdminSectionHeading><div><h2>초대 정보</h2><p>유효 기간이 지나면 새 초대를 발급해야 합니다.</p></div></AdminSectionHeading>
          <form className="grid gap-5 border-t border-muted-border p-5" onSubmit={issue} aria-busy={mutation.isPending}>
            <div className="grid grid-cols-[minmax(0,1fr)_12rem] gap-4 max-[40rem]:grid-cols-1">
              <TextField label="이메일" name="email" type="email" required maxLength={320} autoComplete="email" disabled={mutation.isPending} />
              <SelectField label="유효 기간" name="expiresInSeconds" defaultValue="604800" options={EXPIRATION_OPTIONS} required disabled={mutation.isPending} />
            </div>
            <AdminNote>초대 링크는 한 번만 사용할 수 있습니다. 이메일 발송이 설정되지 않은 환경에서는 발급 직후 링크를 직접 복사해야 합니다.</AdminNote>
            {deliveryNotice ? <p className="m-0 text-sm text-success" role="status">{deliveryNotice}</p> : null}
            {error ? <p className="m-0 text-sm text-danger" role="alert">{error}</p> : null}
            <div className="flex items-center justify-end gap-2"><Link className={buttonVariants({ variant: "secondary" })} href="/admin/access/invitations">취소</Link><Button type="submit" variant="primary" disabled={mutation.isPending}>{mutation.isPending ? "발급 중…" : "초대 발급"}</Button></div>
          </form>
        </AdminSection>
      )}
    </AdminPage>
  );
}

function invitationStatusLabel(status: ActivationInvitation["status"]): string {
  if (status === "pending") return "대기 중";
  if (status === "accepted") return "활성화 완료";
  if (status === "revoked") return "취소됨";
  if (status === "superseded") return "재발급됨";
  return "만료됨";
}
