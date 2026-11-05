import type { Metadata } from "next";
import { redirect, unstable_rethrow } from "next/navigation";

import { EntryUnavailable } from "#src/app/_components/entry-unavailable.tsx";
import { RemoveMember } from "@/app/(workspace)/workspaces/[workspaceId]/members/[userId]/remove/_components/remove-member.tsx";
import { loadWorkspaceMemberContext, requireMember } from "@/app/(workspace)/workspaces/[workspaceId]/members/_utils/member-page-data.ts";
import { isExplicitlySignedOut, safeRequestReference } from "#src/lib/api/presentation-error.ts";

export const metadata: Metadata = { title: "멤버 제외" };

export default async function RemoveWorkspaceMemberPage({ params }: { readonly params: Promise<{ workspaceId: string; userId: string }> }) {
  const { userId, workspaceId } = await params;
  const detailHref = `/workspaces/${encodeURIComponent(workspaceId)}/members/${encodeURIComponent(userId)}`;
  try {
    const context = await loadWorkspaceMemberContext(workspaceId);
    const member = requireMember(context.members, userId, `/workspaces/${encodeURIComponent(workspaceId)}/members`);
    if (!context.canManage || member.userId === context.currentUserId) redirect(detailHref);
    return <RemoveMember member={member} organizationId={context.organization.id} organizationName={context.organization.displayName} workspaceId={workspaceId} />;
  } catch (error) {
    unstable_rethrow(error);
    if (isExplicitlySignedOut(error)) redirect("/sign-in");
    return <EntryUnavailable title="멤버 제외 화면을 불러올 수 없습니다" description="멤버와 변경 권한을 확인하지 못했습니다." reference={safeRequestReference(error)} retryHref={`${detailHref}/remove`} />;
  }
}
