import type { Metadata } from "next";
import { redirect, unstable_rethrow } from "next/navigation";

import { EntryUnavailable } from "#src/app/_components/entry-unavailable.tsx";
import { TeamProjectManager } from "@/app/(workspace)/workspaces/[workspaceId]/teams/[teamId]/projects/_components/team-project-manager.tsx";
import { loadTeamContext } from "@/app/(workspace)/workspaces/[workspaceId]/teams/_utils/team-page-data.ts";
import { isExplicitlySignedOut, safeRequestReference } from "#src/lib/api/presentation-error.ts";

export const metadata: Metadata = { title: "팀 프로젝트 접근" };

export default async function TeamProjectsPage({ params }: { readonly params: Promise<{ workspaceId: string; teamId: string }> }) {
  const { teamId, workspaceId } = await params;
  const href = `/workspaces/${encodeURIComponent(workspaceId)}/teams/${encodeURIComponent(teamId)}/projects`;
  try {
    const context = await loadTeamContext(workspaceId, teamId);
    return <TeamProjectManager canManage={context.canManageProjects} grants={context.projectRoles} organizationId={context.organization.id} organizationName={context.organization.displayName} projects={context.projects} team={context.team} workspaceId={workspaceId} />;
  } catch (error) {
    unstable_rethrow(error);
    if (isExplicitlySignedOut(error)) redirect("/sign-in");
    return <EntryUnavailable title="프로젝트 접근을 불러올 수 없습니다" description="팀의 프로젝트 역할을 안전하게 불러오지 못했습니다." reference={safeRequestReference(error)} retryHref={href} />;
  }
}
