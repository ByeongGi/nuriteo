import type { Metadata } from "next";
import Link from "next/link";
import { redirect, unstable_rethrow } from "next/navigation";

import { EntryUnavailable } from "#src/app/_components/entry-unavailable.tsx";
import { loadWorkspaceMemberContext, requireMember } from "@/app/(workspace)/workspaces/[workspaceId]/members/_utils/member-page-data.ts";
import { WorkspaceFacts, WorkspacePanel, WorkspaceSection } from "@/app/(workspace)/workspaces/[workspaceId]/_components/workspace-section.tsx";
import { Button } from "#src/components/ui/button.tsx";
import { isExplicitlySignedOut, safeRequestReference } from "#src/lib/api/presentation-error.ts";

export const metadata: Metadata = { title: "멤버 상세" };

export default async function WorkspaceMemberDetailPage({ params }: { readonly params: Promise<{ workspaceId: string; userId: string }> }) {
  const { userId, workspaceId } = await params;
  const base = `/workspaces/${encodeURIComponent(workspaceId)}/members`;
  try {
    const context = await loadWorkspaceMemberContext(workspaceId);
    const member = requireMember(context.members, userId, base);
    const canChangeTarget = context.canManage && member.userId !== context.currentUserId;
    return <WorkspaceSection eyebrow={context.organization.displayName} title={member.displayName} description="워크스페이스 멤버의 기본 정보와 현재 역할을 확인합니다." actions={<Button size="sm" render={<Link href={base} />}>멤버 목록</Button>}><WorkspacePanel title="멤버 정보" description="계정의 워크스페이스 멤버십 정보입니다."><WorkspaceFacts items={[{ label: "표시 이름", value: member.displayName }, { label: "역할", value: member.role === "owner" ? "소유자" : "멤버" }, { label: "멤버 ID", value: member.userId }, { label: "현재 계정", value: member.userId === context.currentUserId ? "나" : "다른 멤버" }]} />{canChangeTarget ? <div className="flex flex-wrap gap-2"><Button variant="primary" render={<Link href={`${base}/${encodeURIComponent(member.userId)}/role`} />}>역할 변경</Button><Button render={<Link href={`${base}/${encodeURIComponent(member.userId)}/remove`} />}>워크스페이스에서 제외</Button></div> : null}</WorkspacePanel></WorkspaceSection>;
  } catch (error) {
    unstable_rethrow(error);
    if (isExplicitlySignedOut(error)) redirect("/sign-in");
    return <EntryUnavailable title="멤버 상세를 불러올 수 없습니다" description="멤버 정보를 안전하게 불러오지 못했습니다." reference={safeRequestReference(error)} retryHref={`${base}/${encodeURIComponent(userId)}`} />;
  }
}
