import type { Metadata } from "next";

import { WorkspaceTeamPage } from "#src/app/(workspace)/workspaces/[workspaceId]/teams/workspace-team-page.tsx";

export const metadata: Metadata = { title: "팀 상세" };

export default async function TeamDetailPage({ params }: { readonly params: Promise<{ workspaceId: string; teamId: string }> }) {
  const { teamId, workspaceId } = await params;
  return <WorkspaceTeamPage teamId={teamId} workspaceId={workspaceId} />;
}
