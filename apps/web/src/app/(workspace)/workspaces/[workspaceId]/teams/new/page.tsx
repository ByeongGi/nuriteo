import type { Metadata } from "next";
import { redirect, unstable_rethrow } from "next/navigation";

import { EntryUnavailable } from "#src/app/_components/entry-unavailable.tsx";
import { TeamCreateForm } from "@/app/(workspace)/workspaces/[workspaceId]/teams/new/_components/team-create-form.tsx";
import { loadTeamCollectionContext } from "@/app/(workspace)/workspaces/[workspaceId]/teams/_utils/team-page-data.ts";
import { isExplicitlySignedOut, safeRequestReference } from "#src/lib/api/presentation-error.ts";

export const metadata: Metadata = { title: "새 팀" };

export default async function NewTeamPage({ params }: { readonly params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  try {
    const context = await loadTeamCollectionContext(workspaceId);
    if (!context.canCreateTeam) redirect(`/workspaces/${encodeURIComponent(workspaceId)}/teams`);
    return <TeamCreateForm organizationId={context.organization.id} organizationName={context.organization.displayName} workspaceId={workspaceId} />;
  } catch (error) {
    unstable_rethrow(error);
    if (isExplicitlySignedOut(error)) redirect("/sign-in");
    return <EntryUnavailable title="새 팀 화면을 불러올 수 없습니다" description="팀 생성 권한을 확인하지 못했습니다." reference={safeRequestReference(error)} retryHref={`/workspaces/${encodeURIComponent(workspaceId)}/teams/new`} />;
  }
}
