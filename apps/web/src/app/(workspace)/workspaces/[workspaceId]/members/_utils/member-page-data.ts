import {
  getOrganization,
  listOrganizationMembers
} from "@/services/organizations/api.ts";
import { getCurrentUser } from "@/services/session/api.ts";
import { getCurrentWorkspaces } from "@/services/workspaces/api.ts";
import type {
  OrganizationMember
} from "@nuriteo/api-client";

import "server-only";

import { redirect } from "next/navigation";

import { createServerApiClient } from "#src/lib/api/server-client.ts";

export async function loadWorkspaceMemberContext(workspaceId: string) {
  const client = await createServerApiClient();
  const [current, workspaces] = await Promise.all([getCurrentUser(client), getCurrentWorkspaces(client)]);
  const workspace = workspaces.data.workspaces.find((item) => item.storageScopeId === workspaceId);
  if (workspace === undefined) redirect("/workspaces");
  if (workspace.ownerType !== "organization") redirect(`/workspaces/${encodeURIComponent(workspaceId)}/settings`);
  const [organization, memberCollection] = await Promise.all([
    getOrganization(client, workspace.ownerId),
    listOrganizationMembers(client, workspace.ownerId)
  ]);
  const members = memberCollection.data.items;
  return {
    canManage: members.some((member) => member.userId === current.data.user.id && member.role === "owner"),
    currentUserId: current.data.user.id,
    members,
    organization: organization.data
  };
}

export function requireMember(members: readonly OrganizationMember[], userId: string, fallbackHref: string): OrganizationMember {
  const member = members.find((item) => item.userId === userId);
  if (member === undefined) redirect(fallbackHref);
  return member;
}
