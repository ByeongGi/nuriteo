import {
  ApiError,
  getCurrentWorkspaces,
  getProject,
  listDirectProjectRoles,
  listOrganizationMembers,
  listProjects
} from "@nuriteo/api-client";
import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { EntryUnavailable } from "../../_components/entry-unavailable.tsx";
import { isExplicitlySignedOut, safeRequestReference } from "../../../lib/api/presentation-error.ts";
import { createServerApiClient } from "../../../lib/api/server-client.ts";
import { previewOriginConfiguration } from "../../../lib/preview/config.ts";
import { resolveWorkspaceSelection } from "../../../lib/workspace-selection.ts";
import { ProjectDashboard } from "./project-dashboard.tsx";

export const metadata: Metadata = { title: "Projects" };

const PROJECT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const CONTENT_HASH = /^[0-9a-f]{64}$/u;

interface Props {
  readonly searchParams: Promise<{
    project?: string | string[];
    state?: string | string[];
    workspace?: string | string[];
  }>;
}

export default async function ProjectsPage({ searchParams }: Props) {
  const query = await searchParams;
  const previewConfiguration = previewOriginConfiguration();
  try {
    const client = await createServerApiClient();
    const workspaces = (await getCurrentWorkspaces(client)).data.workspaces;
    const selectedScope = resolveWorkspaceSelection(workspaces, query.workspace);
    const workspace = workspaces.find((item) => item.storageScopeId === selectedScope);
    if (workspace === undefined) {
      return <ProjectDashboard previewConfiguration={previewConfiguration} workspaces={workspaces} />;
    }
    const owner = { ownerType: workspace.ownerType, ownerId: workspace.ownerId } as const;
    const state = query.state === "archived" || query.state === "all" ? query.state : "active";
    const projectId = typeof query.project === "string" && PROJECT_ID.test(query.project)
      ? query.project
      : undefined;
    const roleManagementPromise = workspace.ownerType === "organization" && projectId !== undefined
      ? (async () => {
          try {
            const grantCollection = await listDirectProjectRoles(client, {
              owner,
              projectId,
              pageSize: 100
            });
            const memberCollection = await listOrganizationMembers(client, workspace.ownerId);
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
        })()
      : Promise.resolve(undefined);
    const [collection, projectResult, roleManagement] = await Promise.all([
      listProjects(client, { owner, state, pageSize: 50 }),
      projectId === undefined ? Promise.resolve(undefined) : getProject(client, { owner, projectId }),
      roleManagementPromise
    ]);
    return (
      <ProjectDashboard
        key={`${workspace.storageScopeId}:${state}:${projectResult?.data.id ?? "collection"}`}
        canManageRoles={roleManagement !== undefined}
        initialCollection={collection.data}
        previewConfiguration={previewConfiguration}
        {...runtimeAssetRevisionProps()}
        {...(roleManagement === undefined ? {} : {
          initialGrants: roleManagement.grants,
          organizationMembers: roleManagement.organizationMembers
        })}
        {...(projectResult === undefined ? {} : {
          initialProject: projectResult.data,
          initialProjectEtag: projectResult.etag
        })}
        selectedScope={workspace.storageScopeId}
        selectedState={state}
        workspaces={workspaces}
      />
    );
  } catch (error) {
    if (isExplicitlySignedOut(error)) redirect("/sign-in");
    return (
      <EntryUnavailable
        title="Projects are temporarily unavailable"
        description="Project data could not be loaded safely. No change was attempted."
        reference={safeRequestReference(error)}
        retryHref="/projects"
      />
    );
  }
}

function runtimeAssetRevisionProps(): { readonly runtimeAssetRevision?: string } {
  const revision = process.env.NURITEO_RUNTIME_ASSET_REVISION;
  return revision !== undefined && CONTENT_HASH.test(revision)
    ? { runtimeAssetRevision: revision }
    : {};
}
