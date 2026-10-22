import type {
  Organization,
  OrganizationInvitation,
  OrganizationMember,
  Team,
  TeamMember,
  TeamProjectRole,
  Workspace
} from "@nuriteo/api-client";
import type { Meta, StoryObj } from "@storybook/nextjs-vite";

import { AuthenticatedShellFrame } from "#src/app/(authenticated)/authenticated-shell-frame.tsx";
import {
  TeamConsole,
  type OrganizationMemberOption,
  type ProjectOption
} from "#src/app/(authenticated)/organizations/[organizationId]/teams/team-console.tsx";
import { OrganizationConsole } from "#src/app/(authenticated)/organizations/organization-console.tsx";

const organizationId = "0199ee6c-c777-7000-8000-000000004001";
const currentUserId = "0199ee6c-c777-7000-8000-000000004101";
const selectedTeamId = "0199ee6c-c777-7000-8000-000000004201";
const timestamp = "2026-10-22T01:00:00.000Z";

const organization: Organization = {
  archivedAt: null,
  createdAt: "2026-09-01T01:00:00.000Z",
  displayName: "누리터 팀",
  id: organizationId,
  slug: "nuriteo-team",
  status: "active",
  updatedAt: timestamp,
  version: 18
};

const workspaces: readonly Workspace[] = [
  { displayLabel: "김병기의 워크스페이스", ownerId: currentUserId, ownerType: "user", storageScopeId: "0199ee6c-c777-7000-8000-000000004501" },
  { displayLabel: "누리터 팀", ownerId: organizationId, ownerType: "organization", storageScopeId: "0199ee6c-c777-7000-8000-000000004502" },
  ...Array.from({ length: 18 }, (_, index) => ({
    displayLabel: `협업 조직 ${index + 1}`,
    ownerId: fixtureId(4_600 + index),
    ownerType: "organization" as const,
    storageScopeId: fixtureId(4_700 + index)
  }))
];

const members = createMembers(100);
const invitations = createInvitations(36);
const teams = createTeams(100);
const selectedTeam = teams[0]!;
const teamMembers = createTeamMembers(members.slice(0, 72));
const projects = createProjects(100);
const projectRoles = createProjectRoles(projects.slice(0, 64));

function OrganizationFixture({
  fixtureInvitations = invitations.slice(0, 8),
  fixtureMembers = members.slice(0, 12),
  manageable = true
}: Readonly<{
  fixtureInvitations?: readonly OrganizationInvitation[];
  fixtureMembers?: readonly OrganizationMember[];
  manageable?: boolean;
}>) {
  return (
    <AuthenticatedShellFrame displayName="김병기" email="byeonggi@nuriteo.dev" isInstanceAdmin pathnameOverride="/organizations" themeMode="light" unreadCount={3}>
      <OrganizationConsole
        canManage={manageable}
        currentUserId={currentUserId}
        etag={'"org-v18"'}
        invitations={fixtureInvitations}
        members={fixtureMembers}
        organization={organization}
        workspaces={workspaces}
      />
    </AuthenticatedShellFrame>
  );
}

function TeamFixture({ large = false, manageable = true }: Readonly<{ large?: boolean; manageable?: boolean }>) {
  const visibleTeams = large ? teams : teams.slice(0, 12);
  const visibleMembers = large ? teamMembers : teamMembers.slice(0, 8);
  const visibleRoles = large ? projectRoles : projectRoles.slice(0, 6);
  return (
    <AuthenticatedShellFrame displayName="김병기" email="byeonggi@nuriteo.dev" isInstanceAdmin pathnameOverride={`/organizations/${organizationId}/teams`} themeMode="light" unreadCount={3}>
      <TeamConsole
        canCreateTeam={manageable}
        canDeleteTeam={manageable}
        canManageMembers={manageable}
        canManageProjectRoles={manageable}
        canRenameTeam={manageable}
        currentUserId={currentUserId}
        initialMemberNextCursor={large ? "next-members" : null}
        initialMembers={visibleMembers}
        initialNextTeamCursor={large ? "next-teams" : null}
        initialProjectRoleNextCursor={large ? "next-project-roles" : null}
        initialProjectRoles={visibleRoles}
        organization={organization}
        organizationMembers={members.map(toMemberOption)}
        projects={projects}
        selectedTeam={selectedTeam}
        selectedTeamEtag={'"team-v7"'}
        teams={visibleTeams}
      />
    </AuthenticatedShellFrame>
  );
}

function NewOrganizationScreen() {
  return (
    <AuthenticatedShellFrame displayName="김병기" email="byeonggi@nuriteo.dev" isInstanceAdmin pathnameOverride="/organizations" themeMode="light" unreadCount={3}>
      <OrganizationConsole canManage currentUserId={currentUserId} workspaces={workspaces} />
    </AuthenticatedShellFrame>
  );
}

function createMembers(count: number): readonly OrganizationMember[] {
  return Array.from({ length: count }, (_, index) => ({
    displayName: index === 0 ? "김병기" : `누리터 개발자 ${String(index + 1).padStart(3, "0")}`,
    role: index < 4 ? "owner" : "member",
    userId: index === 0 ? currentUserId : fixtureId(4_101 + index)
  }));
}

function createInvitations(count: number): readonly OrganizationInvitation[] {
  const statuses = ["pending", "accepted", "declined", "revoked", "superseded", "expired"] as const;
  return Array.from({ length: count }, (_, index) => {
    const status = statuses[index % statuses.length]!;
    return {
      acceptedAt: status === "accepted" ? timestamp : null,
      createdAt: "2026-10-18T01:00:00.000Z",
      declinedAt: status === "declined" ? timestamp : null,
      expiredAt: status === "expired" ? timestamp : null,
      expiresAt: `2026-11-${String((index % 20) + 1).padStart(2, "0")}T01:00:00.000Z`,
      id: fixtureId(5_000 + index),
      inviteeUserId: fixtureId(5_100 + index),
      organizationId,
      proposedRole: index % 8 === 0 ? "owner" : "member",
      replacementId: null,
      revokedAt: status === "revoked" ? timestamp : null,
      status,
      supersededAt: status === "superseded" ? timestamp : null
    };
  });
}

function createTeams(count: number): readonly Team[] {
  return Array.from({ length: count }, (_, index) => ({
    createdAt: "2026-09-10T01:00:00.000Z",
    displayName: index === 0 ? "Frontend Platform" : `제품 개발 팀 ${String(index + 1).padStart(3, "0")}`,
    id: index === 0 ? selectedTeamId : fixtureId(6_000 + index),
    organizationId,
    slug: index === 0 ? "frontend-platform" : `product-team-${index + 1}`,
    updatedAt: timestamp,
    version: index === 0 ? 7 : 1 + (index % 8)
  }));
}

function createTeamMembers(source: readonly OrganizationMember[]): readonly TeamMember[] {
  return source.map((member, index) => ({
    createdAt: "2026-09-15T01:00:00.000Z",
    organizationId,
    role: index < 5 ? "maintainer" : "member",
    teamId: selectedTeamId,
    updatedAt: timestamp,
    userId: member.userId,
    version: 1 + (index % 5)
  }));
}

function createProjects(count: number): readonly ProjectOption[] {
  return Array.from({ length: count }, (_, index) => ({
    id: fixtureId(7_000 + index),
    name: index === 0 ? "브라우저 런타임" : `누리터 프로젝트 ${String(index + 1).padStart(3, "0")}`,
    slug: index === 0 ? "browser-runtime" : `nuriteo-project-${index + 1}`
  }));
}

function createProjectRoles(source: readonly ProjectOption[]): readonly TeamProjectRole[] {
  const roles = ["read", "write", "admin"] as const;
  return source.map((project, index) => ({
    createdAt: "2026-09-20T01:00:00.000Z",
    organizationId,
    projectId: project.id,
    role: roles[index % roles.length]!,
    teamId: selectedTeamId,
    updatedAt: timestamp,
    version: 1 + (index % 4)
  }));
}

function toMemberOption(member: OrganizationMember): OrganizationMemberOption {
  return {
    displayName: member.displayName,
    organizationRole: member.role,
    userId: member.userId
  };
}

function fixtureId(value: number): string {
  return `0199ee6c-c777-7000-8000-${String(value).padStart(12, "0")}`;
}

const meta = {
  parameters: {
    layout: "fullscreen",
    nextjs: { appDirectory: true }
  },
  title: "UX Redesign/04 Organization"
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

export const Overview: Story = { render: () => <OrganizationFixture /> };
export const Members: Story = { render: () => <OrganizationFixture fixtureMembers={members} /> };
export const TeamsAndRoles: Story = { render: () => <TeamFixture /> };
export const Invitations: Story = { render: () => <OrganizationFixture fixtureInvitations={invitations} /> };
export const LargeDirectory: Story = { render: () => <TeamFixture large /> };
export const ReadOnlyPermissions: Story = { render: () => <TeamFixture manageable={false} /> };
export const NewOrganization: Story = { render: () => <NewOrganizationScreen /> };
