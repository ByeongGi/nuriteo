import { getCurrentUser, getMfaStatus, listNotifications } from "@nuriteo/api-client";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";

import { EntryUnavailable } from "../_components/entry-unavailable.tsx";
import {
  isExplicitlySignedOut,
  safeRequestReference
} from "../../lib/api/presentation-error.ts";
import { createServerApiClient } from "../../lib/api/server-client.ts";
import { parseThemeMode, THEME_COOKIE_NAME } from "../../lib/theme.ts";
import { AuthenticatedNavigation } from "./authenticated-navigation.tsx";

export default async function AuthenticatedLayout({
  children
}: Readonly<{ children: ReactNode }>) {
  let current: Awaited<ReturnType<typeof getCurrentUser>>;
  let mfa: Awaited<ReturnType<typeof getMfaStatus>>;
  let notifications: Awaited<ReturnType<typeof listNotifications>> | undefined;
  let maintenance: { readonly readOnly: boolean; readonly phase: string } | undefined;
  try {
    const client = await createServerApiClient();
    const mfaRequest = getMfaStatus(client);
    const notificationRequest = listNotifications(client, { limit: 1 }).catch(() => undefined);
    const maintenanceRequest = client
      .get<{ readonly readOnly: boolean; readonly phase: string }>("/maintenance")
      .then((response) => response.data)
      .catch(() => undefined);
    current = await getCurrentUser(client);
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
        description="NURITEO could not verify your session. Retry when the Core service is available."
        reference={safeRequestReference(error)}
        retryHref="/workspaces"
        title="Your workspace is temporarily unavailable"
      />
    );
  }

  if (mfa.data.restricted) redirect("/mfa");
  const cookieStore = await cookies();
  const themeMode = parseThemeMode(cookieStore.get(THEME_COOKIE_NAME)?.value);
  const unreadCount = notifications?.data.unreadCount ?? 0;

  return (
    <div className="authenticated-shell">
      <AuthenticatedNavigation
        displayName={current.data.user.display_name}
        email={current.data.user.email}
        isInstanceAdmin={current.data.user.is_instance_admin}
        themeMode={themeMode}
        unreadCount={unreadCount}
      />
      <div className="authenticated-shell__content" data-navigation-feature="Access tokens">
        {maintenance?.readOnly ? (
          <aside className="maintenance-banner" role="status">
            <strong>유지보수 모드</strong>
            <span>관리 작업이 끝날 때까지 프로젝트는 읽기 전용입니다.</span>
          </aside>
        ) : null}
        {children}
      </div>
    </div>
  );
}
