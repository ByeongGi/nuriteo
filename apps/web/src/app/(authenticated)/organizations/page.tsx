import { getCurrentWorkspaces } from "@/services/workspaces/api.ts";

import type { Metadata } from "next";
import { redirect, unstable_rethrow } from "next/navigation";

import { EntryUnavailable } from "#src/app/_components/entry-unavailable.tsx";
import { isExplicitlySignedOut, safeRequestReference } from "#src/lib/api/presentation-error.ts";
import { createServerApiClient } from "#src/lib/api/server-client.ts";

export const metadata: Metadata = { title: "워크스페이스" };

export default async function OrganizationsPage({
  searchParams
}: Readonly<{ searchParams: Promise<{ organization?: string | string[] }> }>) {
  try {
    const requested = (await searchParams).organization;
    if (typeof requested !== "string") redirect("/workspaces");

    const collection = await getCurrentWorkspaces(await createServerApiClient());
    const workspace = collection.data.workspaces.find(
      (item) => item.ownerType === "organization" && item.ownerId === requested
    );
    if (workspace === undefined) redirect("/workspaces");

    redirect(`/workspaces/${encodeURIComponent(workspace.storageScopeId)}/members`);
  } catch (error) {
    unstable_rethrow(error);
    if (isExplicitlySignedOut(error)) redirect("/sign-in");
    return (
      <EntryUnavailable
        title="워크스페이스를 확인할 수 없습니다"
        description="기존 조직 주소를 현재 워크스페이스 주소로 연결하지 못했습니다."
        reference={safeRequestReference(error)}
        retryHref="/workspaces"
      />
    );
  }
}
