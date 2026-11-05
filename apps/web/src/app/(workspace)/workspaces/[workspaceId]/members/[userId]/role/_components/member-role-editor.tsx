"use client";

import type { OrganizationMember } from "@nuriteo/api-client";
import Link from "next/link";

import { useMemberRoleEditor } from "@/app/(workspace)/workspaces/[workspaceId]/members/[userId]/role/_hooks/use-member-role-editor.ts";
import { memberManagementStyles } from "@/app/(workspace)/workspaces/[workspaceId]/members/_components/member-management.styles.ts";
import { WorkspacePanel, WorkspaceSection } from "@/app/(workspace)/workspaces/[workspaceId]/_components/workspace-section.tsx";
import { Button } from "@/components/ui/button.tsx";
import { SelectField } from "@/components/ui/field.tsx";

export function MemberRoleEditor({ member, organizationId, organizationName, workspaceId }: Readonly<{ member: OrganizationMember; organizationId: string; organizationName: string; workspaceId: string }>) {
  const styles = memberManagementStyles();
  const { error, isPending, role, save, setRole } = useMemberRoleEditor(member, organizationId, workspaceId);
  const detailHref = `/workspaces/${encodeURIComponent(workspaceId)}/members/${encodeURIComponent(member.userId)}`;
  return <WorkspaceSection eyebrow={organizationName} title="역할 변경" description={`${member.displayName} 멤버의 워크스페이스 역할을 변경합니다.`} actions={<Button size="sm" render={<Link href={detailHref} />}>상세로 돌아가기</Button>}>{error ? <p className={styles.error()} role="alert">{error}</p> : null}<WorkspacePanel title="새 역할" description="소유자는 멤버와 워크스페이스 관리 권한을 가집니다."><div className={styles.form()}><SelectField label="역할" options={[{ value: "member", label: "멤버" }, { value: "owner", label: "소유자" }]} value={role} onValueChange={setRole} disabled={isPending} /><div className={styles.actions()}><Button type="button" variant="primary" disabled={isPending || role === member.role} onClick={() => void save()}>역할 저장</Button></div></div></WorkspacePanel></WorkspaceSection>;
}
