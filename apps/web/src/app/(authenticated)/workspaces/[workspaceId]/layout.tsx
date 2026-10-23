import { getCurrentWorkspaces } from "@nuriteo/api-client";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";

import { createServerApiClient } from "#src/lib/api/server-client.ts";
import { WorkspaceNavigation } from "#src/app/(authenticated)/workspaces/[workspaceId]/workspace-navigation.tsx";

export default async function WorkspaceLayout({
  children,
  params
}: Readonly<{ children: ReactNode; params: Promise<{ workspaceId: string }> }>) {
  const { workspaceId } = await params;
  const workspaces = (await getCurrentWorkspaces(await createServerApiClient())).data.workspaces;
  const workspace = workspaces.find((item) => item.storageScopeId === workspaceId);
  if (workspace === undefined) redirect("/workspaces");

  return (
    <div className="min-w-0">
      <WorkspaceNavigation organization={workspace.ownerType === "organization"} workspaceId={workspaceId} />
      {children}
    </div>
  );
}
