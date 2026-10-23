import { getCurrentWorkspaces, getProject } from "@nuriteo/api-client";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";

import { ProjectSettingsNavigation } from "#src/app/(authenticated)/workspaces/[workspaceId]/projects/[projectId]/project-settings-navigation.tsx";
import { createServerApiClient } from "#src/lib/api/server-client.ts";

export default async function ProjectLayout({ children, params }: Readonly<{ children: ReactNode; params: Promise<{ workspaceId: string; projectId: string }> }>) {
  const { projectId, workspaceId } = await params;
  const client = await createServerApiClient();
  const workspaces = (await getCurrentWorkspaces(client)).data.workspaces;
  const workspace = workspaces.find((item) => item.storageScopeId === workspaceId);
  if (workspace === undefined) redirect("/workspaces");
  const project = (await getProject(client, { owner: { ownerType: workspace.ownerType, ownerId: workspace.ownerId }, projectId })).data;
  return <div className="min-w-0"><ProjectSettingsNavigation projectId={projectId} projectName={project.name} workspaceId={workspaceId} />{children}</div>;
}
