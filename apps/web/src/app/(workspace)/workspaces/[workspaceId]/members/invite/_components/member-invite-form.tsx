"use client";

import Link from "next/link";

import { useMemberInviteForm } from "@/app/(workspace)/workspaces/[workspaceId]/members/invite/_hooks/use-member-invite-form.ts";
import { memberManagementStyles } from "@/app/(workspace)/workspaces/[workspaceId]/members/_components/member-management.styles.ts";
import { WorkspacePanel, WorkspaceSection } from "@/app/(workspace)/workspaces/[workspaceId]/_components/workspace-section.tsx";
import { Button } from "@/components/ui/button.tsx";
import { SelectField, TextField } from "@/components/ui/field.tsx";

export function MemberInviteForm({ organizationId, organizationName, workspaceId }: Readonly<{ organizationId: string; organizationName: string; workspaceId: string }>) {
  const styles = memberManagementStyles();
  const { error, handleSubmit, isPending, oneTimeUrl, status } = useMemberInviteForm(organizationId);
  const membersHref = `/workspaces/${encodeURIComponent(workspaceId)}/members`;
  return <WorkspaceSection eyebrow={organizationName} title="멤버 초대" description="한 명의 계정에 워크스페이스 초대를 발급합니다." actions={<><Button size="sm" render={<Link href={`${membersHref}/invitations`} />}>초대 내역</Button><Button size="sm" render={<Link href={membersHref} />}>멤버 목록</Button></>}>
    {oneTimeUrl ? <section className={styles.panel()} aria-live="polite"><h2 className="m-0 text-base">초대 링크</h2><p className={styles.panelCopy()}>이 일회용 링크는 화면을 떠나면 다시 표시되지 않습니다.</p><output className="select-all break-all rounded-md bg-subtle p-3 font-mono text-xs">{oneTimeUrl}</output></section> : null}
    {status ? <p className={styles.status()} role="status">{status}</p> : null}{error ? <p className={styles.error()} role="alert">{error}</p> : null}
    <WorkspacePanel title="초대 정보" description="기존 누리터 계정의 이메일과 처음 부여할 역할을 입력하세요."><form className={styles.form()} onSubmit={handleSubmit} aria-busy={isPending}><TextField label="초대할 이메일" name="email" type="text" inputMode="email" autoComplete="email" autoCapitalize="none" spellCheck={false} required disabled={isPending} /><SelectField label="역할" name="role" options={[{ value: "member", label: "멤버" }, { value: "owner", label: "소유자" }]} defaultValue="member" required disabled={isPending} /><div className={styles.actions()}><Button type="submit" variant="primary" disabled={isPending}>초대 발급</Button></div></form></WorkspacePanel>
  </WorkspaceSection>;
}
