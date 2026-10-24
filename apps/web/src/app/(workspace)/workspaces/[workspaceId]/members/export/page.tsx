import type { Metadata } from "next";
import { redirect, unstable_rethrow } from "next/navigation";

import { EntryUnavailable } from "#src/app/_components/entry-unavailable.tsx";
import { MemberExport } from "#src/app/(workspace)/workspaces/[workspaceId]/members/export/member-export.tsx";
import { loadWorkspaceMemberContext } from "#src/app/(workspace)/workspaces/[workspaceId]/members/member-page-data.ts";
import { isExplicitlySignedOut, safeRequestReference } from "#src/lib/api/presentation-error.ts";

export const metadata: Metadata = { title: "멤버 내보내기" };

export default async function ExportWorkspaceMembersPage({ params }: { readonly params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  try {
    const context = await loadWorkspaceMemberContext(workspaceId);
    return <MemberExport members={context.members} organizationName={context.organization.displayName} workspaceId={workspaceId} />;
  } catch (error) {
    unstable_rethrow(error);
    if (isExplicitlySignedOut(error)) redirect("/sign-in");
    return <EntryUnavailable title="내보내기를 준비할 수 없습니다" description="워크스페이스 멤버를 불러오지 못했습니다." reference={safeRequestReference(error)} retryHref={`/workspaces/${encodeURIComponent(workspaceId)}/members/export`} />;
  }
}
