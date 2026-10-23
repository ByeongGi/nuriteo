import { getCurrentWorkspaces, listProjects } from "@nuriteo/api-client";
import type { Metadata } from "next";
import { redirect, unstable_rethrow } from "next/navigation";

import { EntryUnavailable } from "#src/app/_components/entry-unavailable.tsx";
import { ProjectDashboard } from "#src/app/(authenticated)/projects/project-dashboard.tsx";
import { isExplicitlySignedOut, safeRequestReference } from "#src/lib/api/presentation-error.ts";
import { createServerApiClient } from "#src/lib/api/server-client.ts";

export const metadata: Metadata = { title: "프로젝트" };

interface Props {
  readonly params: Promise<{ workspaceId: string }>;
  readonly searchParams: Promise<{ state?: string | string[] }>;
}

export default async function WorkspaceProjectsPage({ params, searchParams }: Props) {
  const [{ workspaceId }, query] = await Promise.all([params, searchParams]);
  const state = query.state === "archived" || query.state === "all" ? query.state : "active";

  try {
    const client = await createServerApiClient();
    const workspaces = (await getCurrentWorkspaces(client)).data.workspaces;
    const workspace = workspaces.find((item) => item.storageScopeId === workspaceId);
    if (workspace === undefined) redirect("/workspaces");

    const collection = await listProjects(client, {
      owner: { ownerType: workspace.ownerType, ownerId: workspace.ownerId },
      state,
      pageSize: 50
    });

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
        description="이 워크스페이스의 프로젝트 정보를 안전하게 불러오지 못했습니다. 변경 사항은 적용하지 않았습니다."
        reference={safeRequestReference(error)}
        retryHref={`/workspaces/${encodeURIComponent(workspaceId)}/projects`}
      />
    );
  }
}
