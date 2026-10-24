import { listOrganizationInvitations } from "@nuriteo/api-client";
import type { Metadata } from "next";
import { redirect, unstable_rethrow } from "next/navigation";

import { EntryUnavailable } from "#src/app/_components/entry-unavailable.tsx";
import { InvitationDirectory } from "#src/app/(workspace)/workspaces/[workspaceId]/members/invitations/invitation-directory.tsx";
import { loadWorkspaceMemberContext } from "#src/app/(workspace)/workspaces/[workspaceId]/members/member-page-data.ts";
import { isExplicitlySignedOut, safeRequestReference } from "#src/lib/api/presentation-error.ts";
import { createServerApiClient } from "#src/lib/api/server-client.ts";

export const metadata: Metadata = { title: "초대 내역" };

export default async function WorkspaceInvitationsPage({ params }: { readonly params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  try {
    const context = await loadWorkspaceMemberContext(workspaceId);
    if (!context.canManage) redirect(`/workspaces/${encodeURIComponent(workspaceId)}/members`);
    const invitations = await listOrganizationInvitations(await createServerApiClient(), context.organization.id);
    return <InvitationDirectory invitations={invitations.data.items} organizationId={context.organization.id} organizationName={context.organization.displayName} workspaceId={workspaceId} />;
  } catch (error) {
    unstable_rethrow(error);
    if (isExplicitlySignedOut(error)) redirect("/sign-in");
    return <EntryUnavailable title="초대 내역을 불러올 수 없습니다" description="워크스페이스 초대 상태를 안전하게 불러오지 못했습니다." reference={safeRequestReference(error)} retryHref={`/workspaces/${encodeURIComponent(workspaceId)}/members/invitations`} />;
  }
}
