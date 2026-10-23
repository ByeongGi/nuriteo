import {
  ApiError,
  getCurrentUser,
  getCurrentWorkspaces,
  getOrganization,
  listOrganizationInvitations,
  listOrganizationMembers
} from "@nuriteo/api-client";
import type { Metadata } from "next";
import { redirect, unstable_rethrow } from "next/navigation";

import { EntryUnavailable } from "#src/app/_components/entry-unavailable.tsx";
import { OrganizationConsole } from "#src/app/(authenticated)/organizations/organization-console.tsx";
import { isExplicitlySignedOut, safeRequestReference } from "#src/lib/api/presentation-error.ts";
import { createServerApiClient } from "#src/lib/api/server-client.ts";

export const metadata: Metadata = { title: "워크스페이스 멤버" };

export default async function WorkspaceMembersPage({ params }: { readonly params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  try {
    const client = await createServerApiClient();
    const [current, workspaceCollection] = await Promise.all([
      getCurrentUser(client),
      getCurrentWorkspaces(client)
    ]);
    const workspace = workspaceCollection.data.workspaces.find((item) => item.storageScopeId === workspaceId);
    if (workspace === undefined) redirect("/workspaces");
    if (workspace.ownerType !== "organization") redirect(`/workspaces/${encodeURIComponent(workspaceId)}/settings`);

    const [organization, members] = await Promise.all([
      getOrganization(client, workspace.ownerId),
      listOrganizationMembers(client, workspace.ownerId)
    ]);
    let invitations;
    let canManage = true;
    try {
      invitations = (await listOrganizationInvitations(client, workspace.ownerId)).data.items;
    } catch (error) {
      if (error instanceof ApiError && error.status === 403) canManage = false;
      else throw error;
    }

    return (
      <OrganizationConsole
        canManage={canManage}
        context="workspace"
        currentUserId={current.data.user.id}
        etag={organization.etag}
        organization={organization.data}
        members={members.data.items}
        workspaces={[workspace]}
        {...(invitations === undefined ? {} : { invitations })}
      />
    );
  } catch (error) {
    unstable_rethrow(error);
    if (isExplicitlySignedOut(error)) redirect("/sign-in");
    return <EntryUnavailable title="멤버를 불러올 수 없습니다" description="워크스페이스 멤버와 초대 상태를 안전하게 불러오지 못했습니다." reference={safeRequestReference(error)} retryHref={`/workspaces/${encodeURIComponent(workspaceId)}/members`} />;
  }
}
