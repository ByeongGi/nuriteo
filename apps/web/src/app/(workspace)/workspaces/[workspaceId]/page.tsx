import { listProjects } from "@/services/projects/api.ts";
import { getCurrentWorkspaces } from "@/services/workspaces/api.ts";

import type { Metadata } from "next";
import { redirect, unstable_rethrow } from "next/navigation";

import { ProjectDashboard } from "#src/projects/project-dashboard.tsx";
import { EntryUnavailable } from "#src/app/_components/entry-unavailable.tsx";
import { isExplicitlySignedOut, safeRequestReference } from "#src/lib/api/presentation-error.ts";
import { createServerApiClient } from "#src/lib/api/server-client.ts";

export const metadata: Metadata = { title: "워크스페이스 프로젝트" };

interface WorkspacePageProps {
  readonly params: Promise<{ workspaceId: string }>;
  readonly searchParams: Promise<{ state?: string | string[] }>;
}

export default async function WorkspacePage({ params, searchParams }: WorkspacePageProps) {
  const [{ workspaceId }, query] = await Promise.all([params, searchParams]);
  const state = query.state === "archived" || query.state === "all" ? query.state : "active";

  try {
    const client = await createServerApiClient();
    const workspaces = (await getCurrentWorkspaces(client)).data.workspaces;
    const workspace = workspaces.find((item) => item.storageScopeId === workspaceId);
    if (workspace === undefined) redirect("/workspaces");
    const collection = await listProjects(client, {
      owner: { ownerType: workspace.ownerType, ownerId: workspace.ownerId },
      pageSize: 50,
      state
    });

    return (
      <ProjectDashboard
        key={`${workspace.storageScopeId}:${state}:workspace`}
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
        title="워크스페이스 프로젝트를 열 수 없습니다"
        description="이 워크스페이스의 프로젝트 목록을 불러오지 못했습니다. 잠시 후 다시 시도하세요."
        reference={safeRequestReference(error)}
        retryHref={`/workspaces/${encodeURIComponent(workspaceId)}`}
      />
    );
  }
}
