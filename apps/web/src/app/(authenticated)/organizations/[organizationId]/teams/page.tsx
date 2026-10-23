import { getCurrentWorkspaces } from "@nuriteo/api-client";
import type { Metadata } from "next";
import { redirect, unstable_rethrow } from "next/navigation";

import { EntryUnavailable } from "#src/app/_components/entry-unavailable.tsx";
import { isExplicitlySignedOut, safeRequestReference } from "#src/lib/api/presentation-error.ts";
import { createServerApiClient } from "#src/lib/api/server-client.ts";

export const metadata: Metadata = { title: "워크스페이스 팀" };

interface LegacyTeamsPageProps {
  readonly params: Promise<{ organizationId: string }>;
  readonly searchParams: Promise<{ team?: string | string[] }>;
}

export default async function LegacyTeamsPage({ params, searchParams }: LegacyTeamsPageProps) {
  const { organizationId } = await params;
  try {
    const collection = await getCurrentWorkspaces(await createServerApiClient());
    const workspace = collection.data.workspaces.find(
      (item) => item.ownerType === "organization" && item.ownerId === organizationId
    );
    if (workspace === undefined) redirect("/workspaces");

    const requestedTeam = (await searchParams).team;
    const base = `/workspaces/${encodeURIComponent(workspace.storageScopeId)}/teams`;
    redirect(typeof requestedTeam === "string" ? `${base}/${encodeURIComponent(requestedTeam)}` : base);
  } catch (error) {
    unstable_rethrow(error);
    if (isExplicitlySignedOut(error)) redirect("/sign-in");
    return (
      <EntryUnavailable
        title="팀 주소를 연결할 수 없습니다"
        description="기존 조직 주소를 현재 워크스페이스 팀 주소로 연결하지 못했습니다."
        reference={safeRequestReference(error)}
        retryHref="/workspaces"
      />
    );
  }
}
