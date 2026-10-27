"use client";

import { reissueOrganizationInvitation, revokeOrganizationInvitation } from "@nuriteo/api-client";
import type { OrganizationInvitation } from "@nuriteo/api-client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

import { memberManagementStyles } from "#src/app/(workspace)/workspaces/[workspaceId]/members/member-management.styles.ts";
import { WorkspaceSection } from "#src/app/(workspace)/workspaces/[workspaceId]/workspace-section.tsx";
import { Button } from "#src/components/ui/button.tsx";
import { SelectField } from "#src/components/ui/field.tsx";
import { collaborationError, readCsrfCredential } from "#src/lib/api/browser-security.ts";
import { createBrowserApiClient } from "#src/lib/api/browser-client.ts";
import { useExclusiveMutation } from "#src/lib/use-exclusive-mutation.ts";

type InvitationFilter = "all" | "pending";

export function InvitationDirectory({ invitations, organizationId, organizationName, workspaceId }: Readonly<{ invitations: readonly OrganizationInvitation[]; organizationId: string; organizationName: string; workspaceId: string }>) {
  const styles = memberManagementStyles();
  const mutation = useExclusiveMutation();
  const router = useRouter();
  const [filter, setFilter] = useState<InvitationFilter>("pending");
  const [oneTimeUrl, setOneTimeUrl] = useState<string>();
  const [status, setStatus] = useState<string>();
  const [error, setError] = useState<string>();
  const base = `/workspaces/${encodeURIComponent(workspaceId)}/members`;
  const visibleInvitations = useMemo(() => invitations.filter((invitation) => filter === "all" || invitation.status === "pending"), [filter, invitations]);

  async function reissue(invitation: OrganizationInvitation) {
    await mutation.run(async () => {
      setError(undefined); setStatus(undefined); setOneTimeUrl(undefined);
      try {
        const result = await reissueOrganizationInvitation(createBrowserApiClient(), { organizationId, invitationId: invitation.id, role: invitation.proposedRole }, { csrfToken: readCsrfCredential() });
        if (result.data.delivery === "email_queued") setStatus("새 초대 이메일을 전송 대기열에 추가했습니다.");
        else setOneTimeUrl(result.data.acceptUrl.consume());
      } catch (cause) { setError(collaborationError(cause, "organization-invitation-terminal")); }
    });
  }

  async function revoke(invitation: OrganizationInvitation) {
    await mutation.run(async () => {
      setError(undefined); setStatus(undefined); setOneTimeUrl(undefined);
      try {
        await revokeOrganizationInvitation(createBrowserApiClient(), { organizationId, invitationId: invitation.id }, { csrfToken: readCsrfCredential() });
        setStatus("초대를 취소했습니다.");
        router.refresh();
      } catch (cause) { setError(collaborationError(cause, "organization-invitation-terminal")); }
    });
  }

  return <WorkspaceSection eyebrow={organizationName} title="초대 내역" description="발급된 워크스페이스 초대의 상태를 확인하고 관리합니다." actions={<><Button size="sm" render={<Link href={`${base}/invite`} />}>새 초대</Button><Button size="sm" render={<Link href={base} />}>멤버 목록</Button></>}>
    {oneTimeUrl ? <section className={styles.panel()} aria-live="polite"><h2 className="m-0 text-base">새 초대 링크</h2><p className={styles.panelCopy()}>이 일회용 링크는 화면을 떠나면 다시 표시되지 않습니다.</p><output className="select-all break-all rounded-md bg-subtle p-3 font-mono text-xs">{oneTimeUrl}</output></section> : null}
    {status ? <p className={styles.status()} role="status">{status}</p> : null}{error ? <p className={styles.error()} role="alert">{error}</p> : null}
    <div className="flex justify-end"><SelectField className="w-full sm:max-w-52" label="표시 범위" labelHidden options={[{ value: "pending", label: "대기 중" }, { value: "all", label: `전체 ${invitations.length}` }]} value={filter} onValueChange={(value) => setFilter(value === "all" ? "all" : "pending")} /></div>
    {visibleInvitations.length === 0 ? <div className={styles.empty()}>표시할 초대가 없습니다.</div> : <ul className={styles.list()} aria-label="워크스페이스 초대">{visibleInvitations.map((invitation) => <li className={styles.row()} key={invitation.id}><div className={styles.identity()}><span className={styles.name()}>{(function () {
    if (invitation.proposedRole === "owner") {
        return ("소유자 초대");
    }
    return ("멤버 초대");
})()}</span><span className={styles.metadata()}>{invitationStatusLabel(invitation.status)} · {expirationLabel(invitation.expiresAt)}</span></div><span className={styles.role()}>{invitation.inviteeUserId.slice(-8)}</span>{(function () {
    if (invitation.status === "pending") {
        return (<div className={styles.actions()}><Button size="sm" disabled={mutation.isPending} onClick={() => void reissue(invitation)}>다시 발급</Button><Button size="sm" disabled={mutation.isPending} onClick={() => void revoke(invitation)}>취소</Button></div>);
    }
    return (<span />);
})()}</li>)}</ul>}
  </WorkspaceSection>;
}

function expirationLabel(expiresAt: string): string { return `${new Intl.DateTimeFormat("ko-KR", { dateStyle: "medium", timeStyle: "short" }).format(new Date(expiresAt))} 만료`; }
function invitationStatusLabel(status: OrganizationInvitation["status"]): string {
  if (status === "pending") return "전달 대기";
  if (status === "accepted") return "수락됨";
  if (status === "declined") return "거절됨";
  if (status === "revoked") return "취소됨";
  if (status === "superseded") return "교체됨";
  return "만료됨";
}
