import { getCurrentUser, getMfaStatus, listNotifications } from "@nuriteo/api-client";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import type { ReactNode } from "react";

import { EntryUnavailable } from "#src/app/_components/entry-unavailable.tsx";
import {
  isExplicitlySignedOut,
  safeRequestReference
} from "#src/lib/api/presentation-error.ts";
import { createServerApiClient } from "#src/lib/api/server-client.ts";
import { parseThemeMode, THEME_COOKIE_NAME } from "#src/lib/theme.ts";
import {
  AuthenticatedShellFrame,
  AuthenticatedShellLoading
} from "#src/app/(authenticated)/authenticated-shell-frame.tsx";

export default function AuthenticatedLayout({
  children
}: Readonly<{ children: ReactNode }>) {
  return (
    <Suspense fallback={<AuthenticatedShellLoading />}>
      <AuthenticatedSessionBoundary>{children}</AuthenticatedSessionBoundary>
    </Suspense>
  );
}

async function AuthenticatedSessionBoundary({ children }: Readonly<{ children: ReactNode }>) {
  let current: Awaited<ReturnType<typeof getCurrentUser>>;
  let mfa: Awaited<ReturnType<typeof getMfaStatus>>;
  let notifications: Awaited<ReturnType<typeof listNotifications>> | undefined;
  let maintenance: { readonly readOnly: boolean; readonly phase: string } | undefined;
  try {
    const client = await createServerApiClient();
    current = await getCurrentUser(client);
    const mfaRequest = getMfaStatus(client);
    const notificationRequest = listNotifications(client, { limit: 1 }).catch(() => undefined);
    const maintenanceRequest = client
      .get<{ readonly readOnly: boolean; readonly phase: string }>("/maintenance")
      .then((response) => response.data)
      .catch(() => undefined);
    [mfa, notifications, maintenance] = await Promise.all([
      mfaRequest,
      notificationRequest,
      maintenanceRequest
    ]);
  } catch (error) {
    if (isExplicitlySignedOut(error)) {
      redirect("/sign-in");
    }

    return (
      <EntryUnavailable
        description="세션을 확인하지 못했습니다. Core 서비스 상태를 확인한 뒤 다시 시도하세요."
        reference={safeRequestReference(error)}
        retryHref="/workspaces"
        title="워크스페이스를 일시적으로 사용할 수 없습니다"
      />
    );
  }

  if (mfa.data.restricted) redirect("/mfa");
  const cookieStore = await cookies();
  const themeMode = parseThemeMode(cookieStore.get(THEME_COOKIE_NAME)?.value);
  const unreadCount = notifications?.data.unreadCount ?? 0;

  return (
    <AuthenticatedShellFrame
      displayName={current.data.user.display_name}
      email={current.data.user.email}
      isInstanceAdmin={current.data.user.is_instance_admin}
      maintenanceReadOnly={maintenance?.readOnly}
      themeMode={themeMode}
      unreadCount={unreadCount}
    >
      {children}
    </AuthenticatedShellFrame>
  );
}
