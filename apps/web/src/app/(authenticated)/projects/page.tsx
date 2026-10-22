import { getCurrentWorkspaces, listProjects } from "@nuriteo/api-client";
import type { Metadata } from "next";
import { redirect, unstable_rethrow } from "next/navigation";

import { EntryUnavailable } from "#src/app/_components/entry-unavailable.tsx";
import { isExplicitlySignedOut, safeRequestReference } from "#src/lib/api/presentation-error.ts";
import { createServerApiClient } from "#src/lib/api/server-client.ts";
import { resolveWorkspaceSelection } from "#src/lib/workspace-selection.ts";
import { ProjectDashboard } from "#src/app/(authenticated)/projects/project-dashboard.tsx";

export const metadata: Metadata = { title: "프로젝트" };

const PROJECT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

interface Props {
  readonly searchParams: Promise<{
    project?: string | string[];
    state?: string | string[];
    workspace?: string | string[];
  }>;
}

export default async function ProjectsPage({ searchParams }: Props) {
  const query = await searchParams;
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
    const projectId = typeof query.project === "string" && PROJECT_ID.test(query.project) ? query.project : undefined;
    if (projectId !== undefined) {
      redirect(`/projects/${encodeURIComponent(projectId)}?${new URLSearchParams({ workspace: workspace.storageScopeId, state }).toString()}`);
    }
    const collection = await listProjects(client, { owner, state, pageSize: 50 });
    return (
      <ProjectDashboard
        key={`${workspace.storageScopeId}:${state}:collection`}
        initialCollection={collection.data}
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
        title="프로젝트를 일시적으로 사용할 수 없습니다"
        description="프로젝트 정보를 안전하게 불러오지 못했습니다. 변경 사항은 적용하지 않았습니다."
        reference={safeRequestReference(error)}
        retryHref="/projects"
      />
    );
  }
}
