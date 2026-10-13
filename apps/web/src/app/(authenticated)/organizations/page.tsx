import {
  ApiError,
  getCurrentUser,
  getCurrentWorkspaces,
  getOrganization,
  listOrganizationInvitations,
  listOrganizationMembers
} from "@nuriteo/api-client";
import type { Metadata } from "next";

import { EntryUnavailable } from "../../_components/entry-unavailable.tsx";
import { safeRequestReference } from "../../../lib/api/presentation-error.ts";
import { createServerApiClient } from "../../../lib/api/server-client.ts";
import { OrganizationConsole } from "./organization-console.tsx";

export const metadata: Metadata = { title: "Organizations" };

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
    return <EntryUnavailable title="Organizations are temporarily unavailable" description="Organization collaboration data could not be loaded safely." reference={safeRequestReference(error)} retryHref="/organizations" />;
  }
}
