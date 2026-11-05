import type { Metadata } from "next";
import { redirect, unstable_rethrow } from "next/navigation";

import { EntryUnavailable } from "#src/app/_components/entry-unavailable.tsx";
import { MemberInviteForm } from "@/app/(workspace)/workspaces/[workspaceId]/members/invite/_components/member-invite-form.tsx";
import { loadWorkspaceMemberContext } from "@/app/(workspace)/workspaces/[workspaceId]/members/_utils/member-page-data.ts";
import { isExplicitlySignedOut, safeRequestReference } from "#src/lib/api/presentation-error.ts";

export const metadata: Metadata = { title: "멤버 초대" };

export default async function InviteWorkspaceMemberPage({ params }: { readonly params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  try {
    const context = await loadWorkspaceMemberContext(workspaceId);
    if (!context.canManage) redirect(`/workspaces/${encodeURIComponent(workspaceId)}/members`);
    return <MemberInviteForm organizationId={context.organization.id} organizationName={context.organization.displayName} workspaceId={workspaceId} />;
  } catch (error) {
    unstable_rethrow(error);
    if (isExplicitlySignedOut(error)) redirect("/sign-in");
    return <EntryUnavailable title="초대 화면을 불러올 수 없습니다" description="워크스페이스와 초대 권한을 확인하지 못했습니다." reference={safeRequestReference(error)} retryHref={`/workspaces/${encodeURIComponent(workspaceId)}/members/invite`} />;
  }
}
