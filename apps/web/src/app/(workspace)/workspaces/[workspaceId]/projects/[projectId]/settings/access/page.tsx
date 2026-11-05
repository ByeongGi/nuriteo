import { ApiError } from "@/services/http/api.ts";
import { listOrganizationMembers } from "@/services/organizations/api.ts";
import { listDirectProjectRoles } from "@/services/projects/api.ts";

import type { Metadata } from "next";

import { ProjectDashboard } from "#src/projects/project-dashboard.tsx";
import { loadProjectContext } from "@/app/(workspace)/workspaces/[workspaceId]/projects/[projectId]/_utils/project-context.ts";
import { ProjectSettingsNotice, ProjectSettingsPanel, ProjectSettingsSection } from "@/app/(workspace)/workspaces/[workspaceId]/projects/[projectId]/settings/_components/project-settings-section.tsx";

export const metadata: Metadata = { title: "프로젝트 접근 권한" };

export default async function AccessSettingsPage({ params }: { readonly params: Promise<{ projectId: string; workspaceId: string }> }) {
  const { projectId, workspaceId } = await params;
  const { client, project, workspace, workspaces } = await loadProjectContext(workspaceId, projectId);
  if (workspace.ownerType !== "organization") {
    return (
      <ProjectSettingsSection
        projectName={project.data.name}
        title="접근 권한"
        description="개인 워크스페이스 프로젝트의 접근 범위입니다."
      >
        <ProjectSettingsNotice>
          <p>개인 워크스페이스의 프로젝트는 계정 소유자에게만 연결됩니다.</p>
        </ProjectSettingsNotice>
        <ProjectSettingsPanel>
          <p>팀 또는 멤버별 역할이 필요하면 조직 워크스페이스로 프로젝트를 구성하세요. 현재 프로젝트에는 별도의 역할을 추가할 수 없습니다.</p>
        </ProjectSettingsPanel>
      </ProjectSettingsSection>
    );
  }
  let roleManagement;
  try {
    const owner = { ownerType: "organization", ownerId: workspace.ownerId } as const;
    const [grants, members] = await Promise.all([
      listDirectProjectRoles(client, { owner, projectId, pageSize: 100 }),
      listOrganizationMembers(client, workspace.ownerId)
    ]);
    roleManagement = { grants: grants.data.items, members: members.data.items.map(({ displayName, role, userId }) => ({ displayName, role, userId })) };
  } catch (error) {
    if (!(error instanceof ApiError) || (error.status !== 403 && error.status !== 404)) throw error;
  }
  return (
    <ProjectDashboard
      key={`${project.data.id}:${project.data.version}:access`}
      detailSection="access"
      canManageRoles={roleManagement !== undefined}
      initialProject={project.data}
      initialProjectEtag={project.etag}
      {...(roleManagement === undefined ? {} : {
        initialGrants: roleManagement.grants,
        organizationMembers: roleManagement.members
      })}
      selectedScope={workspace.storageScopeId}
      workspaces={workspaces}
    />
  );
}
