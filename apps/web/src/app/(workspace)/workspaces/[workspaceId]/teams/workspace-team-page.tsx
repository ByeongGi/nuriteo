import {
  ApiError,
  getCurrentUser,
  getCurrentWorkspaces,
  getOrganization,
  getProject,
  getTeam,
  listOrganizationMembers,
  listProjects,
  listTeamMembers,
  listTeamProjectRoles,
  listTeams
} from "@nuriteo/api-client";
import type { Project, TeamMember, TeamProjectRole } from "@nuriteo/api-client";
import { redirect, unstable_rethrow } from "next/navigation";

import { EntryUnavailable } from "#src/app/_components/entry-unavailable.tsx";
import { TeamConsole } from "#src/app/(authenticated)/organizations/[organizationId]/teams/team-console.tsx";
import { isExplicitlySignedOut, safeRequestReference } from "#src/lib/api/presentation-error.ts";
import { createServerApiClient } from "#src/lib/api/server-client.ts";

export async function WorkspaceTeamPage({ workspaceId, teamId }: Readonly<{ workspaceId: string; teamId?: string }>) {
  const baseHref = `/workspaces/${encodeURIComponent(workspaceId)}/teams`;
  try {
    const client = await createServerApiClient();
    const [current, workspaceCollection] = await Promise.all([getCurrentUser(client), getCurrentWorkspaces(client)]);
    const workspace = workspaceCollection.data.workspaces.find((item) => item.storageScopeId === workspaceId);
    if (workspace === undefined) redirect("/workspaces");
    if (workspace.ownerType !== "organization") redirect(`/workspaces/${encodeURIComponent(workspaceId)}/settings`);
    const organizationId = workspace.ownerId;
    const [organizationResult, organizationMembersResult, teamsResult] = await Promise.all([
      getOrganization(client, organizationId),
      listOrganizationMembers(client, organizationId),
      listTeams(client, { organizationId, pageSize: 100 })
    ]);
    const organizationMembers = organizationMembersResult.data.items;
    const organizationRole = organizationMembers.find((member) => member.userId === current.data.user.id)?.role;
    const isOrganizationManager = current.data.user.is_instance_admin || organizationRole === "owner";
    const selectedId = teamId !== undefined && teamsResult.data.items.some((team) => team.id === teamId) ? teamId : undefined;
    if (teamId !== undefined && selectedId === undefined) redirect(baseHref);

    let selectedTeam;
    let selectedTeamEtag;
    let members: readonly TeamMember[] = [];
    let memberNextCursor: string | null = null;
    let projectRoles: readonly TeamProjectRole[] = [];
    let projectRoleNextCursor: string | null = null;
    let projects: readonly Project[] = [];
    let canManageMembers = false;

    if (selectedId !== undefined) {
      const managedProjectsPromise = isOrganizationManager
        ? listProjects(client, { owner: { ownerType: "organization", ownerId: organizationId }, state: "active", pageSize: 100 })
        : Promise.resolve(undefined);
      const [teamResult, teamMembersResult, projectRolesResult, managedProjectsResult] = await Promise.all([
        getTeam(client, { organizationId, teamId: selectedId }),
        listTeamMembers(client, { organizationId, teamId: selectedId, pageSize: 100 }),
        listTeamProjectRoles(client, { organizationId, teamId: selectedId, pageSize: 100 }),
        managedProjectsPromise
      ]);
      selectedTeam = teamResult.data;
      selectedTeamEtag = teamResult.etag;
      members = teamMembersResult.data.items;
      memberNextCursor = teamMembersResult.data.nextCursor;
      projectRoles = projectRolesResult.data.items;
      projectRoleNextCursor = projectRolesResult.data.nextCursor;
      canManageMembers = isOrganizationManager || members.some((member) => member.userId === current.data.user.id && member.role === "maintainer");
      projects = managedProjectsResult?.data.items ?? await visibleGrantedProjects(client, organizationId, projectRoles);
    }

    return <TeamConsole
      baseHref={baseHref}
      key={`${organizationId}:${selectedTeam?.id ?? "collection"}:${selectedTeam?.version ?? 0}`}
      canCreateTeam={isOrganizationManager}
      canDeleteTeam={isOrganizationManager && selectedTeam !== undefined}
      canManageMembers={canManageMembers}
      canManageProjectRoles={isOrganizationManager && selectedTeam !== undefined}
      canRenameTeam={canManageMembers}
      currentUserId={current.data.user.id}
      initialMembers={members}
      initialMemberNextCursor={memberNextCursor}
      initialNextTeamCursor={teamsResult.data.nextCursor}
      initialProjectRoles={projectRoles}
      initialProjectRoleNextCursor={projectRoleNextCursor}
      organization={organizationResult.data}
      organizationMembers={organizationMembers.map(({ displayName, role, userId }) => ({ displayName, organizationRole: role, userId }))}
      projects={projects.map(({ id, name, slug }) => ({ id, name, slug }))}
      {...(selectedTeam === undefined ? {} : { selectedTeam })}
      {...(selectedTeamEtag === undefined ? {} : { selectedTeamEtag })}
      teams={teamsResult.data.items}
    />;
  } catch (error) {
    unstable_rethrow(error);
    if (isExplicitlySignedOut(error)) redirect("/sign-in");
    return <EntryUnavailable title="팀을 불러올 수 없습니다" description="팀과 프로젝트 권한 정보를 안전하게 불러오지 못했습니다." reference={safeRequestReference(error)} retryHref={baseHref} />;
  }
}

async function visibleGrantedProjects(
  client: Awaited<ReturnType<typeof createServerApiClient>>,
  organizationId: string,
  grants: readonly TeamProjectRole[]
): Promise<readonly Project[]> {
  const results = await Promise.all(grants.map(async (grant) => {
    try {
      return (await getProject(client, { owner: { ownerType: "organization", ownerId: organizationId }, projectId: grant.projectId })).data;
    } catch (error) {
      if (error instanceof ApiError && (error.status === 403 || error.status === 404)) return undefined;
      throw error;
    }
  }));
  return results.filter((project): project is Project => project !== undefined);
}
