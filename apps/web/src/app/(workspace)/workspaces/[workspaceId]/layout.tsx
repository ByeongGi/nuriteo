import { getCurrentUser, getCurrentWorkspaces, getMfaStatus } from "@nuriteo/api-client";
import { cookies, headers } from "next/headers";
import { redirect, unstable_rethrow } from "next/navigation";
import { Suspense } from "react";
import type { ReactNode } from "react";

import { EntryUnavailable } from "#src/app/_components/entry-unavailable.tsx";
import {
  WorkspaceShellFrame,
  WorkspaceShellLoading
} from "#src/app/(workspace)/workspace-shell-frame.tsx";
import { signInHref } from "#src/app/(public)/sign-in/return-to.ts";
import {
  isExplicitlySignedOut,
  safeRequestReference
} from "#src/lib/api/presentation-error.ts";
import { createServerApiClient } from "#src/lib/api/server-client.ts";
import { parseThemeMode, THEME_COOKIE_NAME } from "#src/lib/theme.ts";

export default function WorkspaceLayout({
  children,
  params
}: Readonly<{ children: ReactNode; params: Promise<{ workspaceId: string }> }>) {
  return (
    <Suspense fallback={<WorkspaceShellLoading />}>
      <WorkspaceSessionBoundary params={params}>{children}</WorkspaceSessionBoundary>
    </Suspense>
  );
}

async function WorkspaceSessionBoundary({
  children,
  params
}: Readonly<{ children: ReactNode; params: Promise<{ workspaceId: string }> }>) {
  const { workspaceId } = await params;

  try {
    const client = await createServerApiClient();
    const [current, mfa, workspaceResult, maintenance] = await Promise.all([
      getCurrentUser(client),
      getMfaStatus(client),
      getCurrentWorkspaces(client),
      client
        .get<{ readonly readOnly: boolean; readonly phase: string }>("/maintenance")
        .then((response) => response.data)
        .catch(() => undefined)
    ]);

    if (mfa.data.restricted) redirect("/mfa");

    const workspace = workspaceResult.data.workspaces.find(
      (item) => item.storageScopeId === workspaceId
    );
    if (workspace === undefined) redirect("/workspaces");

    const cookieStore = await cookies();
    const themeMode = parseThemeMode(cookieStore.get(THEME_COOKIE_NAME)?.value);

    return (
      <WorkspaceShellFrame
        displayName={current.data.user.display_name}
        email={current.data.user.email}
        maintenanceReadOnly={maintenance?.readOnly}
        themeMode={themeMode}
        workspace={workspace}
      >
        {children}
      </WorkspaceShellFrame>
    );
  } catch (error) {
    unstable_rethrow(error);
    if (isExplicitlySignedOut(error)) {
      const requestPath = (await headers()).get("x-nuriteo-request-path")
        ?? `/workspaces/${encodeURIComponent(workspaceId)}`;
      redirect(signInHref(requestPath));
    }

    return (
      <EntryUnavailable
        description="워크스페이스 세션을 확인하지 못했습니다. Core 서비스 상태를 확인한 뒤 다시 시도하세요."
        reference={safeRequestReference(error)}
        retryHref="/workspaces"
        title="워크스페이스를 일시적으로 사용할 수 없습니다"
      />
    );
  }
}
