import { getCurrentWorkspaces } from "@nuriteo/api-client";
import type { Metadata } from "next";
import { redirect, unstable_rethrow } from "next/navigation";

import { EntryUnavailable } from "#src/app/_components/entry-unavailable.tsx";
import {
  isExplicitlySignedOut,
  safeRequestReference
} from "#src/lib/api/presentation-error.ts";
import { createServerApiClient } from "#src/lib/api/server-client.ts";
import { resolveWorkspaceSelection } from "#src/lib/workspace-selection.ts";
import { EmptyWorkspaceScreen, WorkspaceScreen } from "#src/app/(authenticated)/workspaces/workspace-catalog.tsx";

export const metadata: Metadata = {
  title: "워크스페이스"
};

interface WorkspacesPageProps {
  readonly searchParams: Promise<{
    invitation?: string | string[] | undefined;
    joined?: string | string[] | undefined;
    workspace?: string | string[] | undefined;
  }>;
}

export default async function WorkspacesPage({ searchParams }: WorkspacesPageProps) {
  const {
    invitation,
    joined,
    workspace: requestedScope
  } = await searchParams;
  const invitationStatus = joined === "1"
    ? "조직 초대를 수락했습니다. 공유 워크스페이스를 사용할 수 있습니다."
    : invitation === "declined"
      ? "조직 초대를 거절했습니다. 워크스페이스 접근 권한은 추가되지 않았습니다."
      : undefined;
  try {
    const client = await createServerApiClient();
    const result = await getCurrentWorkspaces(client);
    const workspaces = result.data.workspaces;
    const selectedScope = resolveWorkspaceSelection(workspaces, requestedScope);

    if (workspaces.length === 0) {
      return <EmptyWorkspaceScreen />;
    }
    const activeScope = selectedScope ?? workspaces[0]!.storageScopeId;
    const activeWorkspace = workspaces.find((workspace) => workspace.storageScopeId === activeScope) ?? workspaces[0]!;

    return <WorkspaceScreen activeScope={activeWorkspace.storageScopeId} invitationStatus={invitationStatus} workspaces={workspaces} />;
  } catch (error) {
    unstable_rethrow(error);
    if (isExplicitlySignedOut(error)) {
      redirect("/sign-in");
    }

    return (
      <EntryUnavailable
        description="워크스페이스를 불러오지 못했습니다. Core 서비스 상태를 확인한 뒤 다시 시도하세요."
        reference={safeRequestReference(error)}
        retryHref="/workspaces"
        title="워크스페이스를 일시적으로 사용할 수 없습니다"
      />
    );
  }
}
