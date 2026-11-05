import { getCurrentWorkspaces } from "@/services/workspaces/api.ts";

import type { Metadata } from "next";
import { redirect, unstable_rethrow } from "next/navigation";

import { ProjectDashboard } from "#src/projects/project-dashboard.tsx";
import { EntryUnavailable } from "#src/app/_components/entry-unavailable.tsx";
import { isExplicitlySignedOut, safeRequestReference } from "#src/lib/api/presentation-error.ts";
import { createServerApiClient } from "#src/lib/api/server-client.ts";

export const metadata: Metadata = { title: "새 프로젝트" };

export default async function NewProjectPage({ params }: Readonly<{ params: Promise<{ workspaceId: string }> }>) {
  const { workspaceId } = await params;
  try {
    const workspaces = (await getCurrentWorkspaces(await createServerApiClient())).data.workspaces;
    const workspace = workspaces.find((item) => item.storageScopeId === workspaceId);
    if (workspace === undefined) redirect("/workspaces");

    return (
      <ProjectDashboard
        selectedScope={workspace.storageScopeId}
        selectedState="active"
        view="create"
        workspaces={workspaces}
      />
    );
  } catch (error) {
    unstable_rethrow(error);
    if (isExplicitlySignedOut(error)) redirect("/sign-in");
    return (
      <EntryUnavailable
        title="프로젝트 생성 화면을 열 수 없습니다"
        description="워크스페이스 정보를 불러오지 못했습니다. 프로젝트는 생성되지 않았습니다."
        reference={safeRequestReference(error)}
        retryHref={`/workspaces/${encodeURIComponent(workspaceId)}/projects/new`}
      />
    );
  }
}
