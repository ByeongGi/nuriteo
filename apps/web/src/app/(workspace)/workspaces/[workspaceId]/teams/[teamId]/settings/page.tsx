import type { Metadata } from "next";
import { redirect, unstable_rethrow } from "next/navigation";

import { EntryUnavailable } from "#src/app/_components/entry-unavailable.tsx";
import { TeamSettingsForm } from "#src/app/(workspace)/workspaces/[workspaceId]/teams/[teamId]/settings/team-settings-form.tsx";
import { loadTeamContext } from "#src/app/(workspace)/workspaces/[workspaceId]/teams/team-page-data.ts";
import { isExplicitlySignedOut, safeRequestReference } from "#src/lib/api/presentation-error.ts";

export const metadata: Metadata = { title: "팀 설정" };

export default async function TeamSettingsPage({ params }: { readonly params: Promise<{ workspaceId: string; teamId: string }> }) {
  const { teamId, workspaceId } = await params;
  const detail = `/workspaces/${encodeURIComponent(workspaceId)}/teams/${encodeURIComponent(teamId)}`;
  try {
    const context = await loadTeamContext(workspaceId, teamId);
    if (!context.canRenameTeam) redirect(detail);
    return <TeamSettingsForm organizationId={context.organization.id} organizationName={context.organization.displayName} team={context.team} teamEtag={context.teamEtag} workspaceId={workspaceId} />;
  } catch (error) {
    unstable_rethrow(error);
    if (isExplicitlySignedOut(error)) redirect("/sign-in");
    return <EntryUnavailable title="팀 설정을 불러올 수 없습니다" description="팀 정보와 변경 권한을 확인하지 못했습니다." reference={safeRequestReference(error)} retryHref={`${detail}/settings`} />;
  }
}
