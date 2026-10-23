import { getCurrentUser, getCurrentWorkspaces } from "@nuriteo/api-client";
import type { Metadata } from "next";

import { OrganizationConsole } from "#src/app/(authenticated)/organizations/organization-console.tsx";
import { createServerApiClient } from "#src/lib/api/server-client.ts";

export const metadata: Metadata = { title: "조직 워크스페이스 만들기" };

export default async function NewOrganizationWorkspacePage() {
  const client = await createServerApiClient();
  const [current, workspaces] = await Promise.all([
    getCurrentUser(client),
    getCurrentWorkspaces(client)
  ]);
  return <OrganizationConsole canManage context="creation" currentUserId={current.data.user.id} workspaces={workspaces.data.workspaces} />;
}
