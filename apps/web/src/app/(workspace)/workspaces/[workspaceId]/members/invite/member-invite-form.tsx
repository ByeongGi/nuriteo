"use client";

import { issueOrganizationInvitation } from "@nuriteo/api-client";
import Link from "next/link";
import { useState } from "react";
import type { FormEvent } from "react";

import { memberManagementStyles } from "#src/app/(workspace)/workspaces/[workspaceId]/members/member-management.styles.ts";
import { WorkspacePanel, WorkspaceSection } from "#src/app/(workspace)/workspaces/[workspaceId]/workspace-section.tsx";
import { Button } from "#src/components/ui/button.tsx";
import { SelectField, TextField } from "#src/components/ui/field.tsx";
import { collaborationError, readCsrfCredential } from "#src/lib/api/browser-security.ts";
import { createBrowserApiClient } from "#src/lib/api/browser-client.ts";
import { useExclusiveMutation } from "#src/lib/use-exclusive-mutation.ts";

export function MemberInviteForm({ organizationId, organizationName, workspaceId }: Readonly<{ organizationId: string; organizationName: string; workspaceId: string }>) {
  const styles = memberManagementStyles();
  const mutation = useExclusiveMutation();
  const [oneTimeUrl, setOneTimeUrl] = useState<string>();
  const [status, setStatus] = useState<string>();
  const [error, setError] = useState<string>();
  const membersHref = `/workspaces/${encodeURIComponent(workspaceId)}/members`;
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    await mutation.run(async () => {
      setError(undefined); setStatus(undefined); setOneTimeUrl(undefined);
      try {
        const result = await issueOrganizationInvitation(createBrowserApiClient(), { organizationId, email: String(data.get("email") ?? ""), role: String(data.get("role")) === "owner" ? "owner" : "member" }, { csrfToken: readCsrfCredential() });
        if (result.data.delivery === "email_queued") setStatus("초대 이메일을 전송 대기열에 추가했습니다.");
        else setOneTimeUrl(result.data.acceptUrl.consume());
        form.reset();
      } catch (cause) { setError(collaborationError(cause, "organization-invitation-issue")); }
    });
  }
  return <WorkspaceSection eyebrow={organizationName} title="멤버 초대" description="한 명의 계정에 워크스페이스 초대를 발급합니다." actions={<><Button size="sm" render={<Link href={`${membersHref}/invitations`} />}>초대 내역</Button><Button size="sm" render={<Link href={membersHref} />}>멤버 목록</Button></>}>
    {oneTimeUrl ? <section className={styles.panel()} aria-live="polite"><h2 className="m-0 text-base">초대 링크</h2><p className={styles.panelCopy()}>이 일회용 링크는 화면을 떠나면 다시 표시되지 않습니다.</p><output className="select-all break-all rounded-md bg-subtle p-3 font-mono text-xs">{oneTimeUrl}</output></section> : null}
    {status ? <p className={styles.status()} role="status">{status}</p> : null}{error ? <p className={styles.error()} role="alert">{error}</p> : null}
    <WorkspacePanel title="초대 정보" description="기존 누리터 계정의 이메일과 처음 부여할 역할을 입력하세요."><form className={styles.form()} onSubmit={submit} aria-busy={mutation.isPending}><TextField label="초대할 이메일" name="email" type="text" inputMode="email" autoComplete="email" autoCapitalize="none" spellCheck={false} required disabled={mutation.isPending} /><SelectField label="역할" name="role" options={[{ value: "member", label: "멤버" }, { value: "owner", label: "소유자" }]} defaultValue="member" required disabled={mutation.isPending} /><div className={styles.actions()}><Button type="submit" variant="primary" disabled={mutation.isPending}>초대 발급</Button></div></form></WorkspacePanel>
  </WorkspaceSection>;
}
