import { getCurrentUser, getMfaStatus, listNotifications } from "@nuriteo/api-client";
import Link from "next/link";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";

import { EntryUnavailable } from "../_components/entry-unavailable.tsx";
import {
  isExplicitlySignedOut,
  safeRequestReference
} from "../../lib/api/presentation-error.ts";
import { createServerApiClient } from "../../lib/api/server-client.ts";

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
  return (
    <div className="authenticated-shell">
      <header className="authenticated-shell__header">
        <div>
          <p className="eyebrow">Authenticated workspace</p>
          <p className="authenticated-shell__identity">
            Signed in as <strong>{current.data.user.display_name}</strong>
          </p>
        </div>
        <p className="authenticated-shell__email">{current.data.user.email}</p>
      </header>
      <nav className="authenticated-shell__navigation" aria-label="Account navigation">
        <Link href="/workspaces">Workspaces</Link>
        <Link href="/projects">Projects</Link>
        <Link href="/organizations">Organizations</Link>
        <Link href="/mfa">Security</Link>
        <Link href="/identities">Connected identities</Link>
        <Link href="/access-tokens">Access tokens</Link>
        <Link href="/notifications" className="notification-navigation-link">
          Notifications
          {notifications !== undefined && notifications.data.unreadCount > 0 ? <span aria-label={`${notifications.data.unreadCount} unread notifications`}>{notifications.data.unreadCount > 99 ? "99+" : notifications.data.unreadCount}</span> : null}
        </Link>
        {current.data.user.is_instance_admin ? <Link href="/admin/settings">Administration</Link> : null}
      </nav>
      {maintenance?.readOnly ? (
        <aside className="maintenance-banner" role="status">
          <strong>Maintenance mode</strong>
          <span>Projects are read only while an administrator completes maintenance.</span>
        </aside>
      ) : null}
      {children}
    </div>
  );
}
