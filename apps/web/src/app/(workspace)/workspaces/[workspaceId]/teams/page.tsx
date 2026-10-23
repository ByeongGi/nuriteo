import type { Metadata } from "next";

import { WorkspaceTeamPage } from "#src/app/(workspace)/workspaces/[workspaceId]/teams/workspace-team-page.tsx";

export const metadata: Metadata = { title: "워크스페이스 팀" };

export default async function TeamsPage({ params }: { readonly params: Promise<{ workspaceId: string }> }) {
  return <WorkspaceTeamPage workspaceId={(await params).workspaceId} />;
}
