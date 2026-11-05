"use client";

import type { OrganizationMember } from "@nuriteo/api-client";
import Link from "next/link";

import { useRemoveMember } from "@/app/(workspace)/workspaces/[workspaceId]/members/[userId]/remove/_hooks/use-remove-member.ts";
import { memberManagementStyles } from "@/app/(workspace)/workspaces/[workspaceId]/members/_components/member-management.styles.ts";
import { WorkspaceSection } from "@/app/(workspace)/workspaces/[workspaceId]/_components/workspace-section.tsx";
import { Button } from "@/components/ui/button.tsx";

export function RemoveMember({ member, organizationId, organizationName, workspaceId }: Readonly<{ member: OrganizationMember; organizationId: string; organizationName: string; workspaceId: string }>) {
  const styles = memberManagementStyles();
  const { error, isPending, remove } = useRemoveMember(member, organizationId, workspaceId);
  const base = `/workspaces/${encodeURIComponent(workspaceId)}/members`;
  const detailHref = `${base}/${encodeURIComponent(member.userId)}`;
  return <WorkspaceSection eyebrow={organizationName} title="워크스페이스에서 제외" description={`${member.displayName} 멤버의 접근 권한을 제거합니다.`} actions={<Button size="sm" render={<Link href={detailHref} />}>취소</Button>}>{error ? <p className={styles.error()} role="alert">{error}</p> : null}<section className={styles.danger()}><h2 className="m-0 text-base">{member.displayName} 님을 제외할까요?</h2><p className={styles.panelCopy()}>이 멤버는 워크스페이스와 공유 프로젝트에 더 이상 접근할 수 없습니다. 다시 참여하려면 새 초대가 필요합니다.</p><div className={styles.actions()}><Button type="button" variant="danger" disabled={isPending} onClick={() => void remove()}>멤버 제외</Button></div></section></WorkspaceSection>;
}
