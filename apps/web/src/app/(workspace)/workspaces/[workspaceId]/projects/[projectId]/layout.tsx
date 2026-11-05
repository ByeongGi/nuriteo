import { getProject } from "@/services/projects/api.ts";
import { getCurrentWorkspaces } from "@/services/workspaces/api.ts";

import { redirect } from "next/navigation";
import type { ReactNode } from "react";

import { ProjectSettingsNavigation } from "@/app/(workspace)/workspaces/[workspaceId]/projects/[projectId]/_components/project-settings-navigation.tsx";
import { createServerApiClient } from "#src/lib/api/server-client.ts";

export default async function ProjectLayout({ children, params }: Readonly<{ children: ReactNode; params: Promise<{ workspaceId: string; projectId: string }> }>) {
  const { projectId, workspaceId } = await params;
  const client = await createServerApiClient();
  const workspaces = (await getCurrentWorkspaces(client)).data.workspaces;
  const workspace = workspaces.find((item) => item.storageScopeId === workspaceId);
  if (workspace === undefined) redirect("/workspaces");
  const project = (await getProject(client, { owner: { ownerType: workspace.ownerType, ownerId: workspace.ownerId }, projectId })).data;
  return (
    <div className="grid min-w-0 lg:grid-cols-[12.5rem_minmax(0,1fr)]">
      <ProjectSettingsNavigation projectId={projectId} projectName={project.name} workspaceId={workspaceId} />
      <div className="min-w-0">{children}</div>
    </div>
  );
}
