import "server-only";

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
import type { Project, TeamProjectRole } from "@nuriteo/api-client";
import { redirect } from "next/navigation";

import { createServerApiClient } from "#src/lib/api/server-client.ts";

export async function loadTeamCollectionContext(workspaceId: string) {
  const client = await createServerApiClient();
  const [current, workspaceCollection] = await Promise.all([
    getCurrentUser(client),
    getCurrentWorkspaces(client)
  ]);
  const workspace = workspaceCollection.data.workspaces.find((item) => item.storageScopeId === workspaceId);
  if (workspace === undefined) redirect("/workspaces");
  if (workspace.ownerType !== "organization") redirect(`/workspaces/${encodeURIComponent(workspaceId)}/settings`);

  const [organization, organizationMembers, teams] = await Promise.all([
    getOrganization(client, workspace.ownerId),
    listOrganizationMembers(client, workspace.ownerId),
    listTeams(client, { organizationId: workspace.ownerId, pageSize: 100 })
  ]);
  const organizationRole = organizationMembers.data.items.find((member) => member.userId === current.data.user.id)?.role;

  return {
    canCreateTeam: current.data.user.is_instance_admin || organizationRole === "owner",
    client,
    currentUserId: current.data.user.id,
    organization: organization.data,
    organizationMembers: organizationMembers.data.items,
    teams: teams.data.items,
    workspaceId
  };
}

export async function loadTeamContext(workspaceId: string, teamId: string) {
  const collection = await loadTeamCollectionContext(workspaceId);
  if (!collection.teams.some((team) => team.id === teamId)) redirect(`/workspaces/${encodeURIComponent(workspaceId)}/teams`);

  const [team, members, projectRoles] = await Promise.all([
    getTeam(collection.client, { organizationId: collection.organization.id, teamId }),
    listTeamMembers(collection.client, { organizationId: collection.organization.id, teamId, pageSize: 100 }),
    listTeamProjectRoles(collection.client, { organizationId: collection.organization.id, teamId, pageSize: 100 })
  ]);
  const currentTeamRole = members.data.items.find((member) => member.userId === collection.currentUserId)?.role;
  const canManageMembers = collection.canCreateTeam || currentTeamRole === "maintainer";
  const projects = collection.canCreateTeam
    ? (await listProjects(collection.client, { owner: { ownerType: "organization", ownerId: collection.organization.id }, state: "active", pageSize: 100 })).data.items
    : await visibleGrantedProjects(collection.client, collection.organization.id, projectRoles.data.items);

  return {
    ...collection,
    canDeleteTeam: collection.canCreateTeam,
    canManageMembers,
    canManageProjects: collection.canCreateTeam,
    canRenameTeam: canManageMembers,
    members: members.data.items,
    projectRoles: projectRoles.data.items,
    projects,
    team: team.data,
    teamEtag: team.etag
  };
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
