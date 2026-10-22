import {
  ApiError,
  getCurrentWorkspaces,
  getProject,
  listDirectProjectRoles,
  listOrganizationMembers,
  listProjects
} from "@nuriteo/api-client";
import type { Metadata } from "next";
import { redirect, unstable_rethrow } from "next/navigation";

import { EntryUnavailable } from "#src/app/_components/entry-unavailable.tsx";
import { isExplicitlySignedOut, safeRequestReference } from "#src/lib/api/presentation-error.ts";
import { createServerApiClient } from "#src/lib/api/server-client.ts";
import { resolveWorkspaceSelection } from "#src/lib/workspace-selection.ts";
import { ProjectDashboard } from "#src/app/(authenticated)/projects/project-dashboard.tsx";

export const metadata: Metadata = { title: "프로젝트 개요" };

interface Props {
  readonly params: Promise<{ projectId: string }>;
  readonly searchParams: Promise<{
    state?: string | string[];
    workspace?: string | string[];
  }>;
}

export default async function ProjectOverviewPage({ params, searchParams }: Props) {
  const [{ projectId }, query] = await Promise.all([params, searchParams]);
  try {
    const client = await createServerApiClient();
    const workspaces = (await getCurrentWorkspaces(client)).data.workspaces;
    const selectedScope = resolveWorkspaceSelection(workspaces, query.workspace);
    const workspace = workspaces.find((item) => item.storageScopeId === selectedScope);
    if (workspace === undefined) {
      return <ProjectDashboard workspaces={workspaces} />;
    }

    const owner = { ownerType: workspace.ownerType, ownerId: workspace.ownerId } as const;
    const state = query.state === "archived" || query.state === "all" ? query.state : "active";
    const roleManagementPromise = workspace.ownerType === "organization"
      ? loadRoleManagement(
          client,
          { ownerType: "organization", ownerId: workspace.ownerId },
          workspace.ownerId,
          projectId
        )
      : Promise.resolve(undefined);
    const [collection, projectResult, roleManagement] = await Promise.all([
      listProjects(client, { owner, state, pageSize: 50 }),
      getProject(client, { owner, projectId }),
      roleManagementPromise
    ]);

    return (
      <ProjectDashboard
        key={`${workspace.storageScopeId}:${state}:${projectResult.data.id}`}
        canManageRoles={roleManagement !== undefined}
        initialCollection={collection.data}
        initialProject={projectResult.data}
        initialProjectEtag={projectResult.etag}
        {...(roleManagement === undefined ? {} : {
          initialGrants: roleManagement.grants,
          organizationMembers: roleManagement.organizationMembers
        })}
        selectedScope={workspace.storageScopeId}
        selectedState={state}
        workspaces={workspaces}
      />
    );
  } catch (error) {
    unstable_rethrow(error);
    if (isExplicitlySignedOut(error)) redirect("/sign-in");
    return (
      <EntryUnavailable
        title="프로젝트를 불러올 수 없습니다"
        description="프로젝트 개요를 안전하게 불러오지 못했습니다. 변경 사항은 적용되지 않았습니다."
        reference={safeRequestReference(error)}
        retryHref="/projects"
      />
    );
  }
}

async function loadRoleManagement(
  client: Awaited<ReturnType<typeof createServerApiClient>>,
  owner: { readonly ownerType: "organization"; readonly ownerId: string },
  organizationId: string,
  projectId: string
) {
  try {
    const [grantCollection, memberCollection] = await Promise.all([
      listDirectProjectRoles(client, { owner, projectId, pageSize: 100 }),
      listOrganizationMembers(client, organizationId)
    ]);
    return {
      grants: grantCollection.data.items,
      organizationMembers: memberCollection.data.items.map(
        ({ userId, displayName, role }) => ({ userId, displayName, role })
      )
    };
  } catch (error) {
    if (!(error instanceof ApiError) || (error.status !== 403 && error.status !== 404)) throw error;
    return undefined;
  }
}
