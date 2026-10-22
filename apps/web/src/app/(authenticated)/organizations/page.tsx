import {
  ApiError,
  getCurrentUser,
  getCurrentWorkspaces,
  getOrganization,
  listOrganizationInvitations,
  listOrganizationMembers
} from "@nuriteo/api-client";
import type { Metadata } from "next";

import { EntryUnavailable } from "#src/app/_components/entry-unavailable.tsx";
import { safeRequestReference } from "#src/lib/api/presentation-error.ts";
import { createServerApiClient } from "#src/lib/api/server-client.ts";
import { OrganizationConsole } from "#src/app/(authenticated)/organizations/organization-console.tsx";

export const metadata: Metadata = { title: "조직" };

export default async function OrganizationsPage({
  searchParams
}: { searchParams: Promise<{ organization?: string | string[] }> }) {
  try {
    const client = await createServerApiClient();
    const [current, collection] = await Promise.all([
      getCurrentUser(client),
      getCurrentWorkspaces(client)
    ]);
    const requested = (await searchParams).organization;
    const organizationId = typeof requested === "string" && collection.data.workspaces.some(
      (workspace) => workspace.ownerType === "organization" && workspace.ownerId === requested
    ) ? requested : undefined;
    if (organizationId === undefined) {
      return <OrganizationConsole canManage currentUserId={current.data.user.id} workspaces={collection.data.workspaces} />;
    }
    const [organization, members] = await Promise.all([
      getOrganization(client, organizationId),
      listOrganizationMembers(client, organizationId)
    ]);
    let invitations;
    let canManage = true;
    try {
      invitations = (await listOrganizationInvitations(client, organizationId)).data.items;
    } catch (error) {
      if (error instanceof ApiError && error.status === 403) {
        canManage = false;
      } else {
        throw error;
      }
    }
    return <OrganizationConsole canManage={canManage} currentUserId={current.data.user.id} workspaces={collection.data.workspaces} organization={organization.data} etag={organization.etag} members={members.data.items} {...(invitations === undefined ? {} : { invitations })} />;
  } catch (error) {
    return <EntryUnavailable title="조직을 일시적으로 사용할 수 없습니다" description="조직 협업 정보를 안전하게 불러오지 못했습니다." reference={safeRequestReference(error)} retryHref="/organizations" />;
  }
}
