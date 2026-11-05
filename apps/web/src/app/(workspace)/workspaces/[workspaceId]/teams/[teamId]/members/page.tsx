import type { Metadata } from "next";
import { redirect, unstable_rethrow } from "next/navigation";

import { EntryUnavailable } from "#src/app/_components/entry-unavailable.tsx";
import { TeamMemberManager } from "@/app/(workspace)/workspaces/[workspaceId]/teams/[teamId]/members/_components/team-member-manager.tsx";
import { loadTeamContext } from "@/app/(workspace)/workspaces/[workspaceId]/teams/_utils/team-page-data.ts";
import { isExplicitlySignedOut, safeRequestReference } from "#src/lib/api/presentation-error.ts";

export const metadata: Metadata = { title: "팀 멤버" };

export default async function TeamMembersPage({ params }: { readonly params: Promise<{ workspaceId: string; teamId: string }> }) {
  const { teamId, workspaceId } = await params;
  const href = `/workspaces/${encodeURIComponent(workspaceId)}/teams/${encodeURIComponent(teamId)}/members`;
  try {
    const context = await loadTeamContext(workspaceId, teamId);
    return <TeamMemberManager canManage={context.canManageMembers} currentUserId={context.currentUserId} members={context.members} organizationId={context.organization.id} organizationMembers={context.organizationMembers} organizationName={context.organization.displayName} team={context.team} workspaceId={workspaceId} />;
  } catch (error) {
    unstable_rethrow(error);
    if (isExplicitlySignedOut(error)) redirect("/sign-in");
    return <EntryUnavailable title="팀 멤버를 불러올 수 없습니다" description="팀 멤버십 정보를 안전하게 불러오지 못했습니다." reference={safeRequestReference(error)} retryHref={href} />;
  }
}
