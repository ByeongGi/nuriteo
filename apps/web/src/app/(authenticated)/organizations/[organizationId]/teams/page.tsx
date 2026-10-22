import {
  ApiError,
  getCurrentUser,
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
import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";

import { EntryUnavailable } from "#src/app/_components/entry-unavailable.tsx";
import {
  isExplicitlySignedOut,
  safeRequestReference
} from "#src/lib/api/presentation-error.ts";
import { createServerApiClient } from "#src/lib/api/server-client.ts";
import { TeamConsole } from "#src/app/(authenticated)/organizations/[organizationId]/teams/team-console.tsx";

export const metadata: Metadata = { title: "팀과 프로젝트 권한" };

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

interface TeamsPageProps {
  readonly params: Promise<{ organizationId: string }>;
  readonly searchParams: Promise<{ team?: string | string[] }>;
}

export default async function TeamsPage({ params, searchParams }: TeamsPageProps) {
  const { organizationId } = await params;
  if (!UUID_V7.test(organizationId)) notFound();

  try {
    const client = await createServerApiClient();
    const [current, organizationResult, organizationMembersResult, teamsResult] = await Promise.all([
      getCurrentUser(client),
      getOrganization(client, organizationId),
      listOrganizationMembers(client, organizationId),
      listTeams(client, { organizationId, pageSize: 100 })
    ]);
    const organizationMembers = organizationMembersResult.data.items;
    const organizationRole = organizationMembers.find(
      (member) => member.userId === current.data.user.id
    )?.role;
    const isOrganizationManager = current.data.user.is_instance_admin || organizationRole === "owner";
    const requestedTeam = (await searchParams).team;
    const teamId = typeof requestedTeam === "string" && UUID_V7.test(requestedTeam) &&
      teamsResult.data.items.some((team) => team.id === requestedTeam)
      ? requestedTeam
      : undefined;

    let selectedTeam;
    let selectedTeamEtag;
    let members: readonly TeamMember[] = [];
    let memberNextCursor: string | null = null;
    let projectRoles: readonly TeamProjectRole[] = [];
    let projectRoleNextCursor: string | null = null;
    let projects: readonly Project[] = [];
    let canManageMembers = false;

    if (teamId !== undefined) {
      const managedProjectsPromise = isOrganizationManager
        ? listProjects(client, {
            owner: { ownerType: "organization", ownerId: organizationId },
            state: "active",
            pageSize: 100
          })
        : Promise.resolve(undefined);
      const [teamResult, teamMembersResult, projectRolesResult, managedProjectsResult] = await Promise.all([
        getTeam(client, { organizationId, teamId }),
        listTeamMembers(client, { organizationId, teamId, pageSize: 100 }),
        listTeamProjectRoles(client, { organizationId, teamId, pageSize: 100 }),
        managedProjectsPromise
      ]);
      selectedTeam = teamResult.data;
      selectedTeamEtag = teamResult.etag;
      members = teamMembersResult.data.items;
      memberNextCursor = teamMembersResult.data.nextCursor;
      projectRoles = projectRolesResult.data.items;
      projectRoleNextCursor = projectRolesResult.data.nextCursor;
      const currentTeamRole = members.find(
        (member) => member.userId === current.data.user.id
      )?.role;
      canManageMembers = isOrganizationManager || currentTeamRole === "maintainer";

      projects = managedProjectsResult !== undefined
        ? managedProjectsResult.data.items
        : await visibleGrantedProjects(client, organizationId, projectRoles);
    }

    return (
      <TeamConsole
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
        organizationMembers={organizationMembers.map((member) => ({
          displayName: member.displayName,
          organizationRole: member.role,
          userId: member.userId
        }))}
        projects={projects.map(({ id, name, slug }) => ({ id, name, slug }))}
        {...(selectedTeam === undefined ? {} : { selectedTeam })}
        {...(selectedTeamEtag === undefined ? {} : { selectedTeamEtag })}
        teams={teamsResult.data.items}
      />
    );
  } catch (error) {
    if (isExplicitlySignedOut(error)) redirect("/sign-in");
    return (
      <EntryUnavailable
        title="팀과 프로젝트 권한을 일시적으로 불러올 수 없습니다"
        description="팀 접근 데이터를 안전하게 불러오지 못했습니다. 시도된 변경은 없습니다."
        reference={safeRequestReference(error)}
        retryHref={`/organizations/${organizationId}/teams`}
      />
    );
  }
}

async function visibleGrantedProjects(
  client: Awaited<ReturnType<typeof createServerApiClient>>,
  organizationId: string,
  grants: readonly TeamProjectRole[]
): Promise<readonly Project[]> {
  const results = await Promise.all(grants.map(async (grant) => {
    try {
      return (await getProject(client, {
        owner: { ownerType: "organization", ownerId: organizationId },
        projectId: grant.projectId
      })).data;
    } catch (error) {
      if (error instanceof ApiError && (error.status === 403 || error.status === 404)) return undefined;
      throw error;
    }
  }));
  return results.filter((project): project is Project => project !== undefined);
}
