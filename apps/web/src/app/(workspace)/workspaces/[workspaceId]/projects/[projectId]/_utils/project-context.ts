import { getProject } from "@/services/projects/api.ts";
import { getCurrentWorkspaces } from "@/services/workspaces/api.ts";

import { redirect } from "next/navigation";

import { createServerApiClient } from "#src/lib/api/server-client.ts";

export async function loadProjectContext(workspaceId: string, projectId: string) {
  const client = await createServerApiClient();
  const workspaces = (await getCurrentWorkspaces(client)).data.workspaces;
  const workspace = workspaces.find((item) => item.storageScopeId === workspaceId);
  if (workspace === undefined) redirect("/workspaces");
  const project = await getProject(client, {
    owner: { ownerType: workspace.ownerType, ownerId: workspace.ownerId }, projectId
  });
  return { client, project, workspace, workspaces };
}
