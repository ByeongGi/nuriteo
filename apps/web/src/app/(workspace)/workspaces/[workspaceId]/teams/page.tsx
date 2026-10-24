import type { Metadata } from "next";
import { redirect, unstable_rethrow } from "next/navigation";

import { EntryUnavailable } from "#src/app/_components/entry-unavailable.tsx";
import { TeamDirectory } from "#src/app/(workspace)/workspaces/[workspaceId]/teams/team-directory.tsx";
import { loadTeamCollectionContext } from "#src/app/(workspace)/workspaces/[workspaceId]/teams/team-page-data.ts";
import { isExplicitlySignedOut, safeRequestReference } from "#src/lib/api/presentation-error.ts";

export const metadata: Metadata = { title: "워크스페이스 팀" };

export default async function TeamsPage({ params }: { readonly params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  try {
    const context = await loadTeamCollectionContext(workspaceId);
    return <TeamDirectory canCreateTeam={context.canCreateTeam} organizationName={context.organization.displayName} teams={context.teams} workspaceId={workspaceId} />;
  } catch (error) {
    unstable_rethrow(error);
    if (isExplicitlySignedOut(error)) redirect("/sign-in");
    return <EntryUnavailable title="팀을 불러올 수 없습니다" description="워크스페이스 팀 목록을 안전하게 불러오지 못했습니다." reference={safeRequestReference(error)} retryHref={`/workspaces/${encodeURIComponent(workspaceId)}/teams`} />;
  }
}
